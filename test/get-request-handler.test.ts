import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEvent } from 'aws-lambda';
import { mockClient } from 'aws-sdk-client-mock';
import { handler } from '../src/handlers/get-request';
import { resetRepository, type RequestRecord } from '../src/shared/repository';

const documentMock = mockClient(DynamoDBDocumentClient);

const REQUEST_ID = '3f1a9c2e-6b7d-4e3a-9f21-8c5d4b2a1e07';

const storedRecord: RequestRecord = {
  requestId: REQUEST_ID,
  createdAt: '2026-10-08T01:02:03.000Z',
  status: 'succeeded',
  modelId: 'apac.amazon.nova-micro-v1:0',
  environment: 'test',
  promptLength: 46,
  promptFingerprint: 'a1b2c3d4e5f6',
  safetyFlags: [],
  responseText: 'Serverless computing removes servers.',
  stopReason: 'end_turn',
  inputTokens: 12,
  outputTokens: 7,
  latencyMs: 512,
  ttl: 1790000000,
};

function event(requestId: string | undefined) {
  return {
    pathParameters: requestId === undefined ? null : { requestId },
    requestContext: { requestId: 'apigw-correlation-id' },
  } as unknown as APIGatewayProxyEvent;
}

const originalEnv = process.env;

beforeEach(() => {
  documentMock.reset();
  resetRepository();
  process.env = { ...originalEnv, TABLE_NAME: 'request-table', BEDROCK_MODEL_ID: 'test-model' };
});

afterEach(() => {
  process.env = originalEnv;
});

describe('GET /requests/{requestId}', () => {
  it('returns a stored record', async () => {
    documentMock.on(GetCommand).resolves({ Item: storedRecord });

    const response = await handler(event(REQUEST_ID));
    const body = JSON.parse(response.body);

    expect(response.statusCode).toBe(200);
    expect(body).toMatchObject({
      requestId: REQUEST_ID,
      status: 'succeeded',
      response: 'Serverless computing removes servers.',
      modelId: 'apac.amazon.nova-micro-v1:0',
      createdAt: '2026-10-08T01:02:03.000Z',
    });
    expect(body.metadata).toMatchObject({ promptLength: 46, stopReason: 'end_turn' });
  });

  it('does not expose internal attributes', async () => {
    documentMock.on(GetCommand).resolves({ Item: storedRecord });

    const response = await handler(event(REQUEST_ID));

    expect(response.body).not.toContain('promptFingerprint');
    expect(response.body).not.toContain('"ttl"');
    expect(response.body).not.toContain('environment');
  });

  it('queries DynamoDB by primary key only', async () => {
    documentMock.on(GetCommand).resolves({ Item: storedRecord });

    await handler(event(REQUEST_ID));

    expect(documentMock.commandCalls(GetCommand)[0].args[0].input).toEqual({
      TableName: 'request-table',
      Key: { requestId: REQUEST_ID },
    });
  });

  it('returns 404 when the record does not exist', async () => {
    documentMock.on(GetCommand).resolves({});

    const response = await handler(event(REQUEST_ID));

    expect(response.statusCode).toBe(404);
    expect(JSON.parse(response.body).error.code).toBe('NOT_FOUND');
  });

  it('returns null response text for a stored failure record', async () => {
    documentMock.on(GetCommand).resolves({
      Item: {
        ...storedRecord,
        status: 'failed',
        responseText: undefined,
        errorCode: 'MODEL_UNAVAILABLE',
      },
    });

    const response = await handler(event(REQUEST_ID));
    const body = JSON.parse(response.body);

    expect(response.statusCode).toBe(200);
    expect(body.status).toBe('failed');
    expect(body.response).toBeNull();
    expect(body.metadata.errorCode).toBe('MODEL_UNAVAILABLE');
  });

  it.each([
    ['a missing path parameter', undefined, 'MISSING_REQUEST_ID'],
    ['a non-UUID value', 'not-a-uuid', 'INVALID_REQUEST_ID'],
    ['a traversal attempt', '../../admin', 'INVALID_REQUEST_ID'],
  ])('rejects %s with %s before touching DynamoDB', async (_label, value, code) => {
    const response = await handler(event(value));

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error.code).toBe(code);
    expect(documentMock.commandCalls(GetCommand)).toHaveLength(0);
  });

  it('returns 503 with a safe message when DynamoDB fails', async () => {
    documentMock.on(GetCommand).rejects(new Error('table unavailable'));

    const response = await handler(event(REQUEST_ID));
    const body = JSON.parse(response.body);

    expect(response.statusCode).toBe(503);
    expect(body.error.code).toBe('PERSISTENCE_FAILURE');
    expect(response.body).not.toContain('table unavailable');
    expect(response.body).not.toContain('request-table');
  });
});
