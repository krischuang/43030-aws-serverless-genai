/**
 * Local end-to-end integration tests: a real API Gateway-shaped event drives
 * the real `generate` and `get-request` Lambda handlers, Bedrock is routed
 * through the existing `MOCK_BEDROCK` DI seam (no network call, no cost),
 * and DynamoDB persistence goes to a real local `amazon/dynamodb-local`
 * container rather than `aws-sdk-client-mock`.
 *
 * This is deliberately a different kind of test from the existing 155:
 * those prove the application logic is correct against a mock that always
 * does what it's told; this proves the actual DynamoDB wire calls this
 * code makes are well-formed enough to work against a real DynamoDB API
 * implementation.
 *
 * Requires `amazon/dynamodb-local` running locally -- see
 * `docs/local-validation-guide.md` for the one-line setup command. If it
 * is not reachable, the whole suite is SKIPPED (not silently passed) with
 * a message explaining why, and nothing here ever calls real AWS: Bedrock
 * stays mocked by `MOCK_BEDROCK=true`, and DynamoDB is only ever addressed
 * via `AWS_ENDPOINT_URL_DYNAMODB` pointed at localhost with fake credentials.
 */
import type { APIGatewayProxyEvent } from 'aws-lambda';
import { randomUUID } from 'node:crypto';
import { handler as generateHandler } from '../src/handlers/generate';
import { handler as getRequestHandler } from '../src/handlers/get-request';
import { resetGenerationClient } from '../src/shared/bedrock';
import { resetRepository } from '../src/shared/repository';
import {
  configureLocalAwsEnvironment,
  createLocalTable,
  deleteLocalTable,
  getRawStoredItem,
  isDynamoDbLocalReachable,
  LOCAL_DYNAMODB_ENDPOINT,
} from './local-dynamodb-helper';

const dynamoDbLocalAvailable = isDynamoDbLocalReachable();
const describeLocal = dynamoDbLocalAvailable ? describe : describe.skip;

if (!dynamoDbLocalAvailable) {
  it.skip(
    `local integration suite skipped -- no DynamoDB Local reachable at ${LOCAL_DYNAMODB_ENDPOINT} ` +
      '(run `npm run dynamodb:local:up` first; see docs/local-validation-guide.md)',
    () => undefined,
  );
}

function apiGatewayEvent(body: string | null, overrides: Partial<APIGatewayProxyEvent> = {}) {
  return {
    body,
    isBase64Encoded: false,
    requestContext: { requestId: `apigw-${randomUUID()}` },
    ...overrides,
  } as unknown as APIGatewayProxyEvent;
}

function getRequestEvent(requestId: string) {
  return {
    pathParameters: { requestId },
    requestContext: { requestId: `apigw-${randomUUID()}` },
  } as unknown as APIGatewayProxyEvent;
}

describeLocal('Local integration: generate -> DynamoDB Local -> get-request', () => {
  const tableName = `local-integration-${randomUUID()}`;

  beforeAll(async () => {
    configureLocalAwsEnvironment(tableName);
    await createLocalTable(tableName);
  });

  afterAll(async () => {
    await deleteLocalTable(tableName);
  });

  beforeEach(() => {
    configureLocalAwsEnvironment(tableName);
    resetGenerationClient();
    resetRepository();
  });

  it('accepts a valid prompt, invokes the mocked Bedrock client, and persists a real record to DynamoDB Local', async () => {
    const response = await generateHandler(
      apiGatewayEvent(JSON.stringify({ prompt: 'Explain what AWS Lambda does in one sentence.' })),
    );
    const body = JSON.parse(response.body);

    expect(response.statusCode).toBe(200);
    expect(body.response).toContain('[mock-mode]');
    expect(body.metadata.mode).toBe('mock');
    expect(typeof body.requestId).toBe('string');
  });

  it('retrieves the same record from DynamoDB Local via get-request, end to end', async () => {
    const generateResponse = await generateHandler(
      apiGatewayEvent(JSON.stringify({ prompt: 'Describe Amazon DynamoDB in one sentence.' })),
    );
    const { requestId } = JSON.parse(generateResponse.body);

    const getResponse = await getRequestHandler(getRequestEvent(requestId));
    const body = JSON.parse(getResponse.body);

    expect(getResponse.statusCode).toBe(200);
    expect(body.requestId).toBe(requestId);
    expect(body.status).toBe('succeeded');
    expect(body.response).toContain('[mock-mode]');
  });

  it('returns a real 404 (not a mock) for a well-formed but unknown request id', async () => {
    const response = await getRequestHandler(getRequestEvent(randomUUID()));
    expect(response.statusCode).toBe(404);
    expect(JSON.parse(response.body).error.code).toBe('NOT_FOUND');
  });

  it('persists a record whose shape matches the production RequestRecord -- no raw prompt attribute on the real stored item', async () => {
    const prompt = 'A uniquely identifiable local-integration sentence.';
    const generateResponse = await generateHandler(apiGatewayEvent(JSON.stringify({ prompt })));
    const { requestId } = JSON.parse(generateResponse.body);

    // Checked against the REAL stored item in DynamoDB Local, not the
    // get-request HTTP response -- that handler assembles its response
    // field by field and would never surface a leak either way (see its
    // own file header comment), so it proves nothing about what was
    // actually written to the table.
    const item = await getRawStoredItem(tableName, requestId);
    expect(item).toBeDefined();
    expect(item).not.toHaveProperty('prompt');
    expect(item?.promptFingerprint).toMatch(/^[0-9a-f]{12}$/);
    expect(item?.promptLength).toBe(prompt.length);
  });

  it('runs two independent requests without id collision (server-generated UUIDs, real ConditionExpression)', async () => {
    const [first, second] = await Promise.all([
      generateHandler(apiGatewayEvent(JSON.stringify({ prompt: 'First concurrent local request.' }))),
      generateHandler(apiGatewayEvent(JSON.stringify({ prompt: 'Second concurrent local request.' }))),
    ]);

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(JSON.parse(first.body).requestId).not.toBe(JSON.parse(second.body).requestId);
  });
});
