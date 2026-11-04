/**
 * Shared helper for the local-only integration/security test suites
 * (local-integration.test.ts, local-security.test.ts).
 *
 * These tests exercise the real AWS SDK against a real DynamoDB-compatible
 * engine -- the official `amazon/dynamodb-local` Docker image -- instead of
 * `aws-sdk-client-mock`. That is the entire point: the other 155 tests in
 * this repo prove the application logic is correct against a mock that
 * always does what it's told; this suite proves the actual DynamoDB wire
 * calls (PutCommand with a ConditionExpression, GetCommand, attribute
 * marshalling) are well-formed enough to work against a real DynamoDB API
 * implementation, not just a mock that never complains.
 *
 * Safety: every AWS SDK call in this file and in the two test files that
 * import it is forced to a local endpoint with obviously-fake credentials.
 * There is no fallback path to a real AWS endpoint -- `repository.ts`'s
 * `getRepository()` calls `new DynamoDBClient({})`, which resolves its
 * endpoint purely from environment variables when none is passed explicitly,
 * so setting `AWS_ENDPOINT_URL_DYNAMODB` before the handler is invoked is
 * both necessary and sufficient to keep it local. `configureLocalAwsEnvironment`
 * sets that (and the generic `AWS_ENDPOINT_URL` fallback) on every call.
 */
import { execSync } from 'node:child_process';
import {
  CreateTableCommand,
  DeleteTableCommand,
  DynamoDBClient,
  ResourceNotFoundException,
} from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';

export const LOCAL_DYNAMODB_ENDPOINT = process.env.DYNAMODB_LOCAL_ENDPOINT ?? 'http://localhost:8000';
// DynamoDB Local still performs real SigV4 signature validation, which
// requires the access key id to parse as a credential-scope component --
// a hyphenated value like "local-fake-key" breaks that parsing and is
// rejected with UnrecognizedClientException (verified empirically). Plain
// alphanumeric fake values avoid that without being real-looking enough to
// be mistaken for a real AWS key.
export const LOCAL_FAKE_ACCESS_KEY = 'LOCALFAKEACCESSKEY0';
export const LOCAL_FAKE_SECRET_KEY = 'LOCALFAKESECRETACCESSKEY0000000000000000';
export const LOCAL_FAKE_REGION = 'localtest';

/**
 * Synchronous reachability probe, checked once at module-collection time so a
 * whole `describe` block can be skipped (not silently passed) when no local
 * DynamoDB is running. A non-"000" HTTP status (DynamoDB Local returns 400
 * for an unauthenticated GET, which is still "something is listening and
 * speaking HTTP") counts as reachable; curl's own failure, or "000", does not.
 */
export function isDynamoDbLocalReachable(endpoint: string = LOCAL_DYNAMODB_ENDPOINT): boolean {
  try {
    const status = execSync(`curl -s -o /dev/null -w '%{http_code}' --max-time 2 ${endpoint}`, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return status !== '' && status !== '000';
  } catch {
    return false;
  }
}

/**
 * Points every AWS SDK client the handler code constructs at DynamoDB Local
 * with dummy credentials, and forces Bedrock into the existing mock-mode DI
 * seam (`MOCK_BEDROCK`) so no test in this suite can reach real Bedrock
 * either. Call this in `beforeEach`, before importing/invoking any handler.
 */
export function configureLocalAwsEnvironment(tableName: string): void {
  process.env.AWS_ENDPOINT_URL_DYNAMODB = LOCAL_DYNAMODB_ENDPOINT;
  process.env.AWS_ENDPOINT_URL = LOCAL_DYNAMODB_ENDPOINT;
  process.env.AWS_ACCESS_KEY_ID = LOCAL_FAKE_ACCESS_KEY;
  process.env.AWS_SECRET_ACCESS_KEY = LOCAL_FAKE_SECRET_KEY;
  process.env.AWS_REGION = LOCAL_FAKE_REGION;
  process.env.AWS_EC2_METADATA_DISABLED = 'true';
  process.env.TABLE_NAME = tableName;
  process.env.BEDROCK_MODEL_ID = 'local-test-model-id';
  process.env.MAX_PROMPT_LENGTH = '2000';
  process.env.BEDROCK_MAX_OUTPUT_TOKENS = '400';
  process.env.BEDROCK_TEMPERATURE = '0.2';
  process.env.RECORD_TTL_DAYS = '7';
  process.env.ENVIRONMENT_NAME = 'local-test';
  process.env.LOG_LEVEL = 'INFO';
  process.env.MOCK_BEDROCK = 'true';
  delete process.env.GUARDRAIL_ID;
  delete process.env.GUARDRAIL_VERSION;
}

/** A client constructed with explicit local settings, independent of env
 * vars -- used only for test setup/teardown (creating/deleting the table),
 * never by the code under test. */
function setupClient(): DynamoDBClient {
  return new DynamoDBClient({
    endpoint: LOCAL_DYNAMODB_ENDPOINT,
    region: LOCAL_FAKE_REGION,
    credentials: { accessKeyId: LOCAL_FAKE_ACCESS_KEY, secretAccessKey: LOCAL_FAKE_SECRET_KEY },
  });
}

/** Schema matches lib/serverless-genai-stack.ts's RequestTable: partition
 * key `requestId` (string). PAY_PER_REQUEST mirrors the real stack, though
 * DynamoDB Local does not actually meter capacity. */
export async function createLocalTable(tableName: string): Promise<void> {
  const client = setupClient();
  try {
    await client.send(
      new CreateTableCommand({
        TableName: tableName,
        AttributeDefinitions: [{ AttributeName: 'requestId', AttributeType: 'S' }],
        KeySchema: [{ AttributeName: 'requestId', KeyType: 'HASH' }],
        BillingMode: 'PAY_PER_REQUEST',
      }),
    );
  } finally {
    client.destroy();
  }
}

/**
 * Reads the raw stored item directly from DynamoDB Local, bypassing
 * get-request's handler (which assembles its response field by field and
 * so would never surface a leak even if one existed). Used to verify the
 * actual data-minimisation guarantee -- no raw `prompt` attribute -- at
 * the one place it would actually show up: the stored item itself.
 */
export async function getRawStoredItem(
  tableName: string,
  requestId: string,
): Promise<Record<string, unknown> | undefined> {
  const client = DynamoDBDocumentClient.from(setupClient());
  try {
    const result = await client.send(new GetCommand({ TableName: tableName, Key: { requestId } }));
    return result.Item;
  } finally {
    client.destroy();
  }
}

export async function deleteLocalTable(tableName: string): Promise<void> {
  const client = setupClient();
  try {
    await client.send(new DeleteTableCommand({ TableName: tableName }));
  } catch (error) {
    if (!(error instanceof ResourceNotFoundException)) {
      throw error;
    }
  } finally {
    client.destroy();
  }
}
