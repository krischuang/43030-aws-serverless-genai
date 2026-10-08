import { App, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { resolveBedrockModelResources } from '../lib/bedrock-permissions';
import { ServerlessGenAiStack } from '../lib/serverless-genai-stack';
import { resolveSettings } from '../lib/stack-config';

const ENV = { account: '111111111111', region: 'ap-southeast-2' };

function synth(context: Record<string, unknown> = {}): Template {
  const app = new App({
    context: {
      projectName: '43030-ServerlessGenAI',
      environmentName: 'test',
      bedrockModelId: 'apac.amazon.nova-micro-v1:0',
      maxPromptLength: 2000,
      recordTtlDays: 7,
      logRetentionDays: 7,
      enableGuardrail: true,
      apiThrottleRateLimit: 5,
      apiThrottleBurstLimit: 10,
      ...context,
    },
  });
  const stack = new ServerlessGenAiStack(app, 'TestStack', { env: ENV });
  return Template.fromStack(stack);
}

describe('DynamoDB table', () => {
  const template = synth();

  it('uses on-demand billing so an idle stack costs nothing', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      BillingMode: 'PAY_PER_REQUEST',
    });
  });

  it('partitions on requestId', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      KeySchema: [{ AttributeName: 'requestId', KeyType: 'HASH' }],
    });
  });

  it('is encrypted at rest', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      SSESpecification: { SSEEnabled: true },
    });
  });

  it('expires demonstration records through TTL', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TimeToLiveSpecification: { AttributeName: 'ttl', Enabled: true },
    });
  });

  it('is deleted with the stack, as expected for a learning environment', () => {
    template.hasResource('AWS::DynamoDB::Table', { DeletionPolicy: 'Delete' });
  });
});

describe('Lambda functions', () => {
  const template = synth();

  it('creates exactly two functions', () => {
    template.resourceCountIs('AWS::Lambda::Function', 2);
  });

  it('enables active X-Ray tracing on both functions', () => {
    const functions = template.findResources('AWS::Lambda::Function');
    const tracingModes = Object.values(functions).map(
      (fn) => (fn.Properties as { TracingConfig?: { Mode?: string } }).TracingConfig?.Mode,
    );
    expect(tracingModes).toEqual(['Active', 'Active']);
  });

  it('runs on a supported Node.js runtime', () => {
    const functions = template.findResources('AWS::Lambda::Function');
    for (const fn of Object.values(functions)) {
      expect((fn.Properties as { Runtime: string }).Runtime).toBe('nodejs22.x');
    }
  });

  it('passes configuration through the environment rather than hard-coding it', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          BEDROCK_MODEL_ID: 'apac.amazon.nova-micro-v1:0',
          MAX_PROMPT_LENGTH: '2000',
          RECORD_TTL_DAYS: '7',
          ENVIRONMENT_NAME: 'test',
          MOCK_BEDROCK: 'false',
        }),
      },
    });
  });

  it('bounds its own execution time', () => {
    const functions = template.findResources('AWS::Lambda::Function');
    for (const fn of Object.values(functions)) {
      expect((fn.Properties as { Timeout: number }).Timeout).toBeLessThanOrEqual(30);
    }
  });
});

describe('IAM least privilege', () => {
  const template = synth();

  function statements(): Array<Record<string, unknown>> {
    return Object.values(template.findResources('AWS::IAM::Policy')).flatMap(
      (policy) =>
        (
          policy.Properties as {
            PolicyDocument: { Statement: Array<Record<string, unknown>> };
          }
        ).PolicyDocument.Statement,
    );
  }

  it('grants PutItem to the generate function only', () => {
    const writes = statements().filter((statement) => statement.Action === 'dynamodb:PutItem');
    expect(writes).toHaveLength(1);
  });

  it('grants GetItem to the retrieval function only', () => {
    const reads = statements().filter((statement) => statement.Action === 'dynamodb:GetItem');
    expect(reads).toHaveLength(1);
  });

  it('never grants a DynamoDB wildcard action', () => {
    const actions = statements().flatMap((statement) =>
      Array.isArray(statement.Action) ? statement.Action : [statement.Action],
    );
    expect(actions).not.toContain('dynamodb:*');
    expect(actions.filter((action) => String(action).startsWith('dynamodb:')).sort()).toEqual([
      'dynamodb:GetItem',
      'dynamodb:PutItem',
    ]);
  });

  it('scopes bedrock:InvokeModel to the configured model and inference profile', () => {
    const invoke = statements().find(
      (statement) => statement.Sid === 'InvokeConfiguredBedrockModel',
    );
    expect(invoke).toBeDefined();
    expect(invoke?.Action).toBe('bedrock:InvokeModel');
    const resources = invoke?.Resource as unknown[];
    expect(resources).toHaveLength(2);
    expect(JSON.stringify(resources)).toContain(
      'inference-profile/apac.amazon.nova-micro-v1:0',
    );
    expect(JSON.stringify(resources)).toContain('foundation-model/amazon.nova-micro-v1:0');
    expect(resources).not.toContain('*');
  });

  it('scopes bedrock:ApplyGuardrail to the provisioned guardrail', () => {
    const apply = statements().find((statement) => statement.Sid === 'ApplyConfiguredGuardrail');
    expect(apply).toBeDefined();
    expect(apply?.Action).toBe('bedrock:ApplyGuardrail');
    expect(JSON.stringify(apply?.Resource)).toContain('GuardrailArn');
  });

  it('omits Bedrock permissions entirely in mock mode', () => {
    const mockTemplate = synth({ mockBedrock: true, enableGuardrail: false });
    const actions = Object.values(mockTemplate.findResources('AWS::IAM::Policy'))
      .flatMap(
        (policy) =>
          (
            policy.Properties as {
              PolicyDocument: { Statement: Array<{ Action: string | string[] }> };
            }
          ).PolicyDocument.Statement,
      )
      .flatMap((statement) => (Array.isArray(statement.Action) ? statement.Action : [statement.Action]));
    expect(actions.filter((action) => action.startsWith('bedrock:'))).toHaveLength(0);
  });
});

describe('API Gateway', () => {
  const template = synth();

  it('requires IAM authorisation on every method', () => {
    const methods = template.findResources('AWS::ApiGateway::Method');
    const authTypes = Object.values(methods).map(
      (method) => (method.Properties as { AuthorizationType: string }).AuthorizationType,
    );
    expect(authTypes).toHaveLength(2);
    expect(new Set(authTypes)).toEqual(new Set(['AWS_IAM']));
  });

  it('exposes the documented routes', () => {
    template.hasResourceProperties('AWS::ApiGateway::Resource', { PathPart: 'generate' });
    template.hasResourceProperties('AWS::ApiGateway::Resource', { PathPart: 'requests' });
    template.hasResourceProperties('AWS::ApiGateway::Resource', { PathPart: '{requestId}' });
  });

  it('validates the request body against a bounded JSON schema', () => {
    template.hasResourceProperties('AWS::ApiGateway::RequestValidator', {
      ValidateRequestBody: true,
      ValidateRequestParameters: true,
    });
    template.hasResourceProperties('AWS::ApiGateway::Model', {
      Schema: Match.objectLike({
        required: ['prompt'],
        additionalProperties: false,
        properties: { prompt: { type: 'string', minLength: 3, maxLength: 2000 } },
      }),
    });
  });

  it('throttles the stage and enables tracing, metrics and access logging', () => {
    template.hasResourceProperties('AWS::ApiGateway::Stage', {
      StageName: 'test',
      TracingEnabled: true,
      AccessLogSetting: Match.objectLike({ DestinationArn: Match.anyValue() }),
      MethodSettings: Match.arrayWith([
        Match.objectLike({
          ThrottlingRateLimit: 5,
          ThrottlingBurstLimit: 10,
          MetricsEnabled: true,
          DataTraceEnabled: false,
        }),
      ]),
    });
  });

  it('is a regional endpoint rather than an edge-optimised one', () => {
    template.hasResourceProperties('AWS::ApiGateway::RestApi', {
      EndpointConfiguration: { Types: ['REGIONAL'] },
    });
  });
});

describe('Bedrock guardrail', () => {
  it('provisions a guardrail with content and sensitive-information policies', () => {
    const template = synth();

    template.resourceCountIs('AWS::Bedrock::Guardrail', 1);
    template.resourceCountIs('AWS::Bedrock::GuardrailVersion', 1);
    template.hasResourceProperties('AWS::Bedrock::Guardrail', {
      ContentPolicyConfig: {
        FiltersConfig: Match.arrayWith([
          Match.objectLike({ Type: 'PROMPT_ATTACK', InputStrength: 'HIGH', OutputStrength: 'NONE' }),
        ]),
      },
      SensitiveInformationPolicyConfig: {
        PiiEntitiesConfig: Match.arrayWith([
          Match.objectLike({ Type: 'AWS_SECRET_KEY', Action: 'BLOCK' }),
        ]),
      },
    });
  });

  it('can be disabled through context for accounts without guardrail access', () => {
    const template = synth({ enableGuardrail: false });
    template.resourceCountIs('AWS::Bedrock::Guardrail', 0);
    template.resourceCountIs('AWS::Bedrock::GuardrailVersion', 0);
  });
});

describe('Observability resources', () => {
  const template = synth();

  it('creates explicit log groups with bounded retention', () => {
    const logGroups = template.findResources('AWS::Logs::LogGroup');
    expect(Object.keys(logGroups)).toHaveLength(3);
    for (const group of Object.values(logGroups)) {
      expect((group.Properties as { RetentionInDays: number }).RetentionInDays).toBe(7);
    }
  });

  it('alarms on Lambda errors and API 5XX responses', () => {
    template.resourceCountIs('AWS::CloudWatch::Alarm', 2);
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      MetricName: 'Errors',
      Namespace: 'AWS/Lambda',
      Threshold: 0,
      ComparisonOperator: 'GreaterThanThreshold',
      TreatMissingData: 'notBreaching',
    });
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      MetricName: '5XXError',
      Namespace: 'AWS/ApiGateway',
      Threshold: 0,
    });
  });

  it('publishes a single operations dashboard', () => {
    template.resourceCountIs('AWS::CloudWatch::Dashboard', 1);
  });
});

describe('Cost and tagging guardrails', () => {
  const template = synth();

  it('creates no always-on or network infrastructure', () => {
    for (const type of [
      'AWS::EC2::Instance',
      'AWS::EC2::VPC',
      'AWS::EC2::NatGateway',
      'AWS::RDS::DBInstance',
      'AWS::ElasticLoadBalancingV2::LoadBalancer',
      'AWS::OpenSearchService::Domain',
      'AWS::ECS::Cluster',
    ]) {
      template.resourceCountIs(type, 0);
    }
  });

  it('tags the taggable resources for cost attribution', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      Tags: Match.arrayWith([
        { Key: 'Project', Value: '43030-ServerlessGenAI' },
        { Key: 'Purpose', Value: 'ProfessionalLearning' },
      ]),
    });
  });

  it('exports the endpoints needed for verification', () => {
    const outputs = Object.keys(template.findOutputs('*'));
    expect(outputs).toEqual(
      expect.arrayContaining([
        'ApiBaseUrl',
        'BedrockMode',
        'BedrockModelId',
        'GenerateEndpoint',
        'GenerateFunctionName',
        'GuardrailEnabled',
        'RequestTableName',
      ]),
    );
  });

  it('exports no account identifier', () => {
    expect(JSON.stringify(template.findOutputs('*'))).not.toContain(ENV.account);
  });
});

describe('resolveBedrockModelResources', () => {
  const stack = new Stack(new App(), 'ArnStack', { env: ENV });

  it('expands an inference profile id to the profile and its foundation model', () => {
    const result = resolveBedrockModelResources(stack, 'apac.amazon.nova-micro-v1:0');

    expect(result.isInferenceProfile).toBe(true);
    expect(result.baseModelId).toBe('amazon.nova-micro-v1:0');
    expect(result.resourceArns).toHaveLength(2);
  });

  it('keeps a plain foundation model id scoped to the stack region', () => {
    const result = resolveBedrockModelResources(stack, 'amazon.nova-micro-v1:0');

    expect(result.isInferenceProfile).toBe(false);
    expect(result.baseModelId).toBe('amazon.nova-micro-v1:0');
    expect(result.resourceArns).toHaveLength(1);
    expect(result.resourceArns[0]).toContain(
      ':bedrock:ap-southeast-2::foundation-model/amazon.nova-micro-v1:0',
    );
    expect(result.resourceArns[0]).not.toContain('bedrock:*');
  });
});

describe('resolveSettings', () => {
  it('falls back to documented defaults when context is absent', () => {
    const settings = resolveSettings(new App());

    expect(settings).toMatchObject({
      projectName: '43030-ServerlessGenAI',
      environmentName: 'dev',
      maxPromptLength: 2000,
      enableGuardrail: true,
      mockBedrock: false,
    });
  });

  it('reads overrides from CDK context', () => {
    const app = new App({
      context: { environmentName: 'staging', maxPromptLength: 500, mockBedrock: 'true' },
    });
    const settings = resolveSettings(app);

    expect(settings.environmentName).toBe('staging');
    expect(settings.maxPromptLength).toBe(500);
    expect(settings.mockBedrock).toBe(true);
  });

  it('rejects a non-numeric numeric context value', () => {
    const app = new App({ context: { maxPromptLength: 'lots' } });
    expect(() => resolveSettings(app)).toThrow(/must be numeric/);
  });

  it('rejects an unsupported log retention value at synthesis time', () => {
    expect(() => synth({ logRetentionDays: 11 })).toThrow(/Unsupported logRetentionDays/);
  });
});
