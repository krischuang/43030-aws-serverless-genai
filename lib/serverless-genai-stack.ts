/**
 * Serverless GenAI Request Service — infrastructure definition.
 *
 * Shape:
 *
 *   API Gateway (REST, IAM authorisation, request validation, throttling)
 *     -> Lambda (Node.js 22, X-Ray active tracing, structured JSON logs)
 *          -> Amazon Bedrock (Converse API, optional guardrail)
 *          -> Amazon DynamoDB (on-demand, encrypted, TTL)
 *     -> CloudWatch (log groups, metrics, alarms, dashboard)
 *
 * Every construct below is sized for a low-cost university demonstration: no
 * VPC, no NAT, no provisioned capacity, and nothing that bills while idle.
 */

import {
  CfnOutput,
  Duration,
  RemovalPolicy,
  Stack,
  StackProps,
  Tags,
} from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as bedrock from 'aws-cdk-lib/aws-bedrock';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sns from 'aws-cdk-lib/aws-sns';
import { Construct } from 'constructs';
import * as path from 'node:path';
import { resolveBedrockModelResources } from './bedrock-permissions';
import { resolveSettings, type StackSettings } from './stack-config';

export interface ServerlessGenAiStackProps extends StackProps {
  /** Optional override; defaults to values resolved from CDK context. */
  readonly settings?: StackSettings;
}

export class ServerlessGenAiStack extends Stack {
  readonly settings: StackSettings;

  constructor(scope: Construct, id: string, props: ServerlessGenAiStackProps = {}) {
    super(scope, id, props);

    const settings = props.settings ?? resolveSettings(this);
    this.settings = settings;

    Tags.of(this).add('Project', settings.projectName);
    Tags.of(this).add('Purpose', 'ProfessionalLearning');
    Tags.of(this).add('Environment', settings.environmentName);
    Tags.of(this).add('ManagedBy', 'AWS-CDK');

    const logRetention = resolveRetention(settings.logRetentionDays);

    // ---------------------------------------------------------------- data
    // On-demand billing so an idle stack costs nothing; server-side
    // encryption with the AWS managed key (no monthly key charge); TTL so
    // demonstration records expire automatically. Point-in-time recovery is
    // intentionally disabled — the table holds disposable demo data only, and
    // the removal policy destroys it on stack deletion.
    const table = new dynamodb.Table(this, 'RequestTable', {
      partitionKey: { name: 'requestId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      timeToLiveAttribute: 'ttl',
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: false },
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // ----------------------------------------------------------- guardrail
    const guardrail = settings.enableGuardrail ? this.createGuardrail(settings) : undefined;

    // -------------------------------------------------------------- lambda
    const sharedEnvironment: Record<string, string> = {
      TABLE_NAME: table.tableName,
      BEDROCK_MODEL_ID: settings.bedrockModelId,
      BEDROCK_MAX_OUTPUT_TOKENS: String(settings.bedrockMaxOutputTokens),
      BEDROCK_TEMPERATURE: String(settings.bedrockTemperature),
      MAX_PROMPT_LENGTH: String(settings.maxPromptLength),
      RECORD_TTL_DAYS: String(settings.recordTtlDays),
      ENVIRONMENT_NAME: settings.environmentName,
      LOG_LEVEL: 'INFO',
      MOCK_BEDROCK: String(settings.mockBedrock),
      NODE_OPTIONS: '--enable-source-maps',
      // Keep the AWS SDK's own retry behaviour bounded so a Bedrock outage
      // cannot hold the Lambda open for its full timeout.
      AWS_MAX_ATTEMPTS: '2',
    };

    if (guardrail) {
      sharedEnvironment.GUARDRAIL_ID = guardrail.guardrailId;
      sharedEnvironment.GUARDRAIL_VERSION = guardrail.guardrailVersion;
    }

    const generateFunction = this.createFunction('GenerateFunction', {
      entry: path.join(__dirname, '..', 'src', 'handlers', 'generate.ts'),
      description: 'Validates a prompt, invokes Amazon Bedrock and records the result',
      timeout: Duration.seconds(30),
      memorySize: 512,
      environment: sharedEnvironment,
      logRetention,
    });

    const getRequestFunction = this.createFunction('GetRequestFunction', {
      entry: path.join(__dirname, '..', 'src', 'handlers', 'get-request.ts'),
      description: 'Returns a previously stored generation request record',
      timeout: Duration.seconds(10),
      memorySize: 256,
      environment: sharedEnvironment,
      logRetention,
    });

    // ----------------------------------------------------------------- iam
    // Least privilege: a single DynamoDB action per function rather than the
    // broader grantWriteData / grantReadData helpers.
    table.grant(generateFunction, 'dynamodb:PutItem');
    table.grant(getRequestFunction, 'dynamodb:GetItem');

    const modelResources = resolveBedrockModelResources(this, settings.bedrockModelId);

    if (!settings.mockBedrock) {
      generateFunction.addToRolePolicy(
        new iam.PolicyStatement({
          sid: 'InvokeConfiguredBedrockModel',
          effect: iam.Effect.ALLOW,
          actions: ['bedrock:InvokeModel'],
          resources: modelResources.resourceArns,
        }),
      );

      if (guardrail) {
        generateFunction.addToRolePolicy(
          new iam.PolicyStatement({
            sid: 'ApplyConfiguredGuardrail',
            effect: iam.Effect.ALLOW,
            actions: ['bedrock:ApplyGuardrail'],
            resources: [guardrail.guardrailArn],
          }),
        );
      }
    }

    // ----------------------------------------------------------------- api
    const api = this.createApi(settings, logRetention);
    const requestModel = this.createRequestModel(api, settings);
    const validator = api.addRequestValidator('GenerateRequestValidator', {
      requestValidatorName: 'validate-generate-body',
      validateRequestBody: true,
      validateRequestParameters: true,
    });

    // AWS_IAM authorisation: callers must present SigV4 credentials, so the
    // endpoint is never anonymously reachable. See docs/security.md for why
    // this was chosen over deploying a full identity provider.
    api.root.addResource('generate').addMethod(
      'POST',
      new apigateway.LambdaIntegration(generateFunction, { proxy: true }),
      {
        authorizationType: apigateway.AuthorizationType.IAM,
        requestValidator: validator,
        requestModels: { 'application/json': requestModel },
        methodResponses: [
          { statusCode: '200' },
          { statusCode: '400' },
          { statusCode: '422' },
          { statusCode: '502' },
        ],
      },
    );

    api.root
      .addResource('requests')
      .addResource('{requestId}')
      .addMethod('GET', new apigateway.LambdaIntegration(getRequestFunction, { proxy: true }), {
        authorizationType: apigateway.AuthorizationType.IAM,
        requestValidator: validator,
        requestParameters: { 'method.request.path.requestId': true },
        methodResponses: [{ statusCode: '200' }, { statusCode: '400' }, { statusCode: '404' }],
      });

    // ------------------------------------------------------- observability
    const alarmTopic = new sns.Topic(this, 'AlarmTopic', {
      displayName: `${settings.projectName} alarms`,
      enforceSSL: true,
    });

    this.createAlarms(settings, api, generateFunction, alarmTopic);
    this.createDashboard(settings, api, generateFunction, getRequestFunction, table);

    // ------------------------------------------------------------- outputs
    // Account-identifying values are deliberately not exported.
    new CfnOutput(this, 'ApiBaseUrl', {
      value: api.url,
      description: 'Base URL of the IAM-authorised REST API',
    });
    new CfnOutput(this, 'GenerateEndpoint', {
      value: `${api.url}generate`,
      description: 'POST endpoint for prompt generation',
    });
    new CfnOutput(this, 'RequestTableName', {
      value: table.tableName,
      description: 'DynamoDB table holding request records',
    });
    new CfnOutput(this, 'GenerateFunctionName', {
      value: generateFunction.functionName,
      description: 'Lambda function handling POST /generate',
    });
    new CfnOutput(this, 'BedrockModelId', {
      value: settings.bedrockModelId,
      description: 'Configured Bedrock model or inference profile id',
    });
    new CfnOutput(this, 'BedrockMode', {
      value: settings.mockBedrock ? 'mock' : 'live',
      description: 'Whether the Lambda calls Bedrock or returns mock output',
    });
    new CfnOutput(this, 'GuardrailEnabled', {
      value: String(guardrail !== undefined),
      description: 'Whether a Bedrock guardrail is attached to model invocations',
    });
  }

  private createFunction(
    id: string,
    props: {
      entry: string;
      description: string;
      timeout: Duration;
      memorySize: number;
      environment: Record<string, string>;
      logRetention: logs.RetentionDays;
    },
  ): NodejsFunction {
    const logGroup = new logs.LogGroup(this, `${id}LogGroup`, {
      retention: props.logRetention,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    return new NodejsFunction(this, id, {
      entry: props.entry,
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      description: props.description,
      timeout: props.timeout,
      memorySize: props.memorySize,
      environment: props.environment,
      logGroup,
      // Active tracing gives API Gateway -> Lambda traces in X-Ray without
      // adding a tracing SDK to the bundle.
      tracing: lambda.Tracing.ACTIVE,
      bundling: {
        minify: true,
        sourceMap: true,
        target: 'node22',
        format: OutputFormat.CJS,
        // The AWS SDK is bundled rather than taken from the runtime image so
        // that a deployment is reproducible against a pinned SDK version.
        externalModules: [],
      },
    });
  }

  private createGuardrail(settings: StackSettings): {
    guardrailId: string;
    guardrailArn: string;
    guardrailVersion: string;
  } {
    const guardrail = new bedrock.CfnGuardrail(this, 'ContentGuardrail', {
      name: `${settings.projectName}-${settings.environmentName}-guardrail`.toLowerCase(),
      description: 'Content and sensitive-information controls for the portfolio demonstration',
      blockedInputMessaging:
        'This request was blocked by the content policy and was not sent to the model.',
      blockedOutputsMessaging: 'The generated response was blocked by the content policy.',
      contentPolicyConfig: {
        filtersConfig: [
          { type: 'HATE', inputStrength: 'HIGH', outputStrength: 'HIGH' },
          { type: 'VIOLENCE', inputStrength: 'HIGH', outputStrength: 'HIGH' },
          { type: 'SEXUAL', inputStrength: 'HIGH', outputStrength: 'HIGH' },
          { type: 'INSULTS', inputStrength: 'MEDIUM', outputStrength: 'MEDIUM' },
          { type: 'MISCONDUCT', inputStrength: 'MEDIUM', outputStrength: 'MEDIUM' },
          // Bedrock requires PROMPT_ATTACK to be input-only.
          { type: 'PROMPT_ATTACK', inputStrength: 'HIGH', outputStrength: 'NONE' },
        ],
      },
      sensitiveInformationPolicyConfig: {
        piiEntitiesConfig: [
          { type: 'AWS_ACCESS_KEY', action: 'BLOCK' },
          { type: 'AWS_SECRET_KEY', action: 'BLOCK' },
          { type: 'PASSWORD', action: 'BLOCK' },
          { type: 'CREDIT_DEBIT_CARD_NUMBER', action: 'BLOCK' },
          { type: 'EMAIL', action: 'ANONYMIZE' },
          { type: 'PHONE', action: 'ANONYMIZE' },
        ],
      },
    });
    guardrail.applyRemovalPolicy(RemovalPolicy.DESTROY);

    const version = new bedrock.CfnGuardrailVersion(this, 'ContentGuardrailVersion', {
      guardrailIdentifier: guardrail.attrGuardrailId,
      description: 'Immutable version consumed by the generate Lambda',
    });
    version.applyRemovalPolicy(RemovalPolicy.DESTROY);

    return {
      guardrailId: guardrail.attrGuardrailId,
      guardrailArn: guardrail.attrGuardrailArn,
      guardrailVersion: version.attrVersion,
    };
  }

  private createApi(
    settings: StackSettings,
    logRetention: logs.RetentionDays,
  ): apigateway.RestApi {
    const accessLogGroup = new logs.LogGroup(this, 'ApiAccessLogs', {
      retention: logRetention,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    return new apigateway.RestApi(this, 'GenAiApi', {
      restApiName: `${settings.projectName}-${settings.environmentName}`,
      description: 'IAM-authorised REST API for the serverless generative AI request service',
      endpointTypes: [apigateway.EndpointType.REGIONAL],
      // Creates the account-level API Gateway CloudWatch Logs role required
      // for stage logging. This is an account-wide setting — see
      // docs/security.md before deploying into a shared account.
      cloudWatchRole: true,
      cloudWatchRoleRemovalPolicy: RemovalPolicy.DESTROY,
      deployOptions: {
        stageName: settings.environmentName,
        tracingEnabled: true,
        metricsEnabled: true,
        loggingLevel: apigateway.MethodLoggingLevel.INFO,
        // Never enable data tracing: it writes full request and response
        // bodies, which would place user prompts in CloudWatch Logs.
        dataTraceEnabled: false,
        throttlingRateLimit: settings.apiThrottleRateLimit,
        throttlingBurstLimit: settings.apiThrottleBurstLimit,
        accessLogDestination: new apigateway.LogGroupLogDestination(accessLogGroup),
        accessLogFormat: apigateway.AccessLogFormat.custom(
          JSON.stringify({
            requestId: apigateway.AccessLogField.contextRequestId(),
            httpMethod: apigateway.AccessLogField.contextHttpMethod(),
            resourcePath: apigateway.AccessLogField.contextResourcePath(),
            status: apigateway.AccessLogField.contextStatus(),
            responseLatency: apigateway.AccessLogField.contextResponseLatency(),
            callerAccount: apigateway.AccessLogField.contextIdentityAccountId(),
            integrationError: apigateway.AccessLogField.contextIntegrationErrorMessage(),
          }),
        ),
      },
    });
  }

  private createRequestModel(
    api: apigateway.RestApi,
    settings: StackSettings,
  ): apigateway.Model {
    return api.addModel('GenerateRequestModel', {
      contentType: 'application/json',
      modelName: 'GenerateRequest',
      schema: {
        schema: apigateway.JsonSchemaVersion.DRAFT4,
        title: 'GenerateRequest',
        type: apigateway.JsonSchemaType.OBJECT,
        required: ['prompt'],
        additionalProperties: false,
        properties: {
          prompt: {
            type: apigateway.JsonSchemaType.STRING,
            minLength: 3,
            maxLength: settings.maxPromptLength,
          },
        },
      },
    });
  }

  private createAlarms(
    settings: StackSettings,
    api: apigateway.RestApi,
    generateFunction: NodejsFunction,
    topic: sns.Topic,
  ): void {
    const action = new cloudwatchActions.SnsAction(topic);

    const lambdaErrors = new cloudwatch.Alarm(this, 'GenerateFunctionErrorAlarm', {
      alarmName: `${settings.projectName}-${settings.environmentName}-generate-errors`,
      alarmDescription: 'The generate Lambda reported at least one error in a 5 minute period',
      metric: generateFunction.metricErrors({ period: Duration.minutes(5), statistic: 'Sum' }),
      threshold: 0,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    lambdaErrors.addAlarmAction(action);

    const apiServerErrors = new cloudwatch.Alarm(this, 'ApiServerErrorAlarm', {
      alarmName: `${settings.projectName}-${settings.environmentName}-api-5xx`,
      alarmDescription: 'The REST API returned at least one 5XX response in a 5 minute period',
      metric: api.metricServerError({ period: Duration.minutes(5), statistic: 'Sum' }),
      threshold: 0,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    apiServerErrors.addAlarmAction(action);
  }

  private createDashboard(
    settings: StackSettings,
    api: apigateway.RestApi,
    generateFunction: NodejsFunction,
    getRequestFunction: NodejsFunction,
    table: dynamodb.Table,
  ): void {
    const dashboard = new cloudwatch.Dashboard(this, 'OperationsDashboard', {
      dashboardName: `${settings.projectName}-${settings.environmentName}`,
    });

    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'API requests and errors',
        width: 12,
        left: [api.metricCount({ statistic: 'Sum' })],
        right: [
          api.metricClientError({ statistic: 'Sum' }),
          api.metricServerError({ statistic: 'Sum' }),
        ],
      }),
      new cloudwatch.GraphWidget({
        title: 'API latency (p50 / p99)',
        width: 12,
        left: [
          api.metricLatency({ statistic: 'p50' }),
          api.metricLatency({ statistic: 'p99' }),
        ],
      }),
    );

    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Lambda invocations and errors',
        width: 12,
        left: [
          generateFunction.metricInvocations({ statistic: 'Sum' }),
          getRequestFunction.metricInvocations({ statistic: 'Sum' }),
        ],
        right: [
          generateFunction.metricErrors({ statistic: 'Sum' }),
          getRequestFunction.metricErrors({ statistic: 'Sum' }),
        ],
      }),
      new cloudwatch.GraphWidget({
        title: 'Generate Lambda duration',
        width: 12,
        left: [
          generateFunction.metricDuration({ statistic: 'p50' }),
          generateFunction.metricDuration({ statistic: 'p99' }),
        ],
      }),
    );

    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'DynamoDB consumed capacity',
        width: 24,
        left: [
          table.metricConsumedWriteCapacityUnits({ statistic: 'Sum' }),
          table.metricConsumedReadCapacityUnits({ statistic: 'Sum' }),
        ],
      }),
    );
  }
}

function resolveRetention(days: number): logs.RetentionDays {
  const supported: Record<number, logs.RetentionDays> = {
    1: logs.RetentionDays.ONE_DAY,
    3: logs.RetentionDays.THREE_DAYS,
    5: logs.RetentionDays.FIVE_DAYS,
    7: logs.RetentionDays.ONE_WEEK,
    14: logs.RetentionDays.TWO_WEEKS,
    30: logs.RetentionDays.ONE_MONTH,
    90: logs.RetentionDays.THREE_MONTHS,
  };
  const retention = supported[days];
  if (retention === undefined) {
    throw new Error(
      `Unsupported logRetentionDays "${days}". Use one of: ${Object.keys(supported).join(', ')}`,
    );
  }
  return retention;
}
