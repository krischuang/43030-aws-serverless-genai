import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { PersistenceError } from '../src/shared/errors';
import {
  DynamoRequestRepository,
  getRepository,
  resetRepository,
  ttlFromNow,
  type RequestRecord,
} from '../src/shared/repository';

const documentMock = mockClient(DynamoDBDocumentClient);

const TABLE_NAME = 'request-table';

const record: RequestRecord = {
  requestId: '3f1a9c2e-6b7d-4e3a-9f21-8c5d4b2a1e07',
  createdAt: '2026-10-08T01:02:03.000Z',
  status: 'succeeded',
  modelId: 'apac.amazon.nova-micro-v1:0',
  environment: 'dev',
  promptLength: 46,
  promptFingerprint: 'a1b2c3d4e5f6',
  safetyFlags: [],
  responseText: 'Serverless means no servers.',
  stopReason: 'end_turn',
  inputTokens: 12,
  outputTokens: 7,
  latencyMs: 512,
  ttl: 1760000000,
};

function repository(): DynamoRequestRepository {
  const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  return new DynamoRequestRepository(documentClient, TABLE_NAME);
}

describe('ttlFromNow', () => {
  it('returns epoch seconds offset by the requested number of days', () => {
    const now = new Date('2026-10-08T00:00:00.000Z');
    expect(ttlFromNow(7, now)).toBe(Math.floor(now.getTime() / 1000) + 7 * 86400);
  });

  it('supports fractional days for short-lived demonstration records', () => {
    const now = new Date('2026-10-08T00:00:00.000Z');
    expect(ttlFromNow(0.5, now)).toBe(Math.floor(now.getTime() / 1000) + 43200);
  });
});

describe('DynamoRequestRepository.put', () => {
  beforeEach(() => {
    documentMock.reset();
    resetRepository();
  });

  it('writes the record to the configured table with an idempotency guard', async () => {
    documentMock.on(PutCommand).resolves({});

    await repository().put(record);

    const calls = documentMock.commandCalls(PutCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0].args[0].input).toMatchObject({
      TableName: TABLE_NAME,
      Item: record,
      ConditionExpression: 'attribute_not_exists(requestId)',
    });
  });

  it('persists a ttl attribute so demonstration records expire', async () => {
    documentMock.on(PutCommand).resolves({});

    await repository().put(record);

    const item = documentMock.commandCalls(PutCommand)[0].args[0].input.Item as RequestRecord;
    expect(typeof item.ttl).toBe('number');
    expect(item.ttl).toBeGreaterThan(0);
  });

  it('never persists the raw prompt text', async () => {
    documentMock.on(PutCommand).resolves({});

    await repository().put(record);

    const item = documentMock.commandCalls(PutCommand)[0].args[0].input.Item as Record<
      string,
      unknown
    >;
    expect(item).not.toHaveProperty('prompt');
    expect(item).not.toHaveProperty('promptText');
    expect(item.promptFingerprint).toBe('a1b2c3d4e5f6');
  });

  it('wraps a DynamoDB failure in a safe persistence error', async () => {
    documentMock
      .on(PutCommand)
      .rejects(Object.assign(new Error('boom'), { name: 'ProvisionedThroughputExceededException' }));

    const error = (await repository()
      .put(record)
      .catch((e: unknown) => e)) as PersistenceError;

    expect(error).toBeInstanceOf(PersistenceError);
    expect(error.statusCode).toBe(503);
    expect(error.clientMessage).not.toContain(TABLE_NAME);
  });
});

describe('DynamoRequestRepository.get', () => {
  beforeEach(() => {
    documentMock.reset();
    resetRepository();
  });

  it('returns a stored record', async () => {
    documentMock.on(GetCommand).resolves({ Item: record });

    await expect(repository().get(record.requestId)).resolves.toEqual(record);

    expect(documentMock.commandCalls(GetCommand)[0].args[0].input).toMatchObject({
      TableName: TABLE_NAME,
      Key: { requestId: record.requestId },
    });
  });

  it('returns undefined when the record does not exist', async () => {
    documentMock.on(GetCommand).resolves({});

    await expect(repository().get(record.requestId)).resolves.toBeUndefined();
  });

  it('wraps a DynamoDB failure in a safe persistence error', async () => {
    documentMock.on(GetCommand).rejects(new Error('network down'));

    await expect(repository().get(record.requestId)).rejects.toBeInstanceOf(PersistenceError);
  });
});

describe('getRepository', () => {
  beforeEach(() => resetRepository());

  it('memoises the repository across invocations', () => {
    const first = getRepository(TABLE_NAME);
    expect(getRepository(TABLE_NAME)).toBe(first);
  });
});
