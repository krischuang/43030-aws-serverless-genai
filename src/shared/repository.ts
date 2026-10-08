/**
 * DynamoDB persistence for request records.
 *
 * Data minimisation: the raw user prompt is never stored. Only the prompt
 * length and a one-way SHA-256 fingerprint are kept, which is enough to
 * correlate repeated prompts and to analyse evaluation runs without retaining
 * user-supplied text. See docs/security.md.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { PersistenceError } from './errors';
import type { SafetyFlag } from './validation';

export type RequestStatus = 'succeeded' | 'blocked' | 'failed';

export interface RequestRecord {
  readonly requestId: string;
  readonly createdAt: string;
  readonly status: RequestStatus;
  readonly modelId: string;
  readonly environment: string;
  readonly promptLength: number;
  readonly promptFingerprint: string;
  readonly safetyFlags: SafetyFlag[];
  readonly responseText?: string;
  readonly stopReason?: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly latencyMs?: number;
  readonly errorCode?: string;
  /** Unix epoch seconds; the table's TTL attribute. */
  readonly ttl: number;
}

export interface RequestRepository {
  put(record: RequestRecord): Promise<void>;
  get(requestId: string): Promise<RequestRecord | undefined>;
}

export function ttlFromNow(days: number, now: Date = new Date()): number {
  return Math.floor(now.getTime() / 1000) + Math.round(days * 24 * 60 * 60);
}

export class DynamoRequestRepository implements RequestRepository {
  constructor(
    private readonly documentClient: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  async put(record: RequestRecord): Promise<void> {
    try {
      await this.documentClient.send(
        new PutCommand({
          TableName: this.tableName,
          Item: record,
          // Request ids are server-generated UUIDs; this guard makes the write
          // idempotent and surfaces any accidental collision instead of
          // silently overwriting an existing record.
          ConditionExpression: 'attribute_not_exists(requestId)',
        }),
      );
    } catch (error) {
      const name = error instanceof Error ? error.name : 'UnknownError';
      throw new PersistenceError(`DynamoDB put failed (${name}) for table ${this.tableName}`);
    }
  }

  async get(requestId: string): Promise<RequestRecord | undefined> {
    try {
      const result = await this.documentClient.send(
        new GetCommand({
          TableName: this.tableName,
          Key: { requestId },
        }),
      );
      return result.Item as RequestRecord | undefined;
    } catch (error) {
      const name = error instanceof Error ? error.name : 'UnknownError';
      throw new PersistenceError(`DynamoDB get failed (${name}) for table ${this.tableName}`);
    }
  }
}

let cachedRepository: RequestRepository | undefined;

/** Reuses the document client across warm invocations. */
export function getRepository(tableName: string): RequestRepository {
  if (cachedRepository === undefined) {
    const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
      marshallOptions: { removeUndefinedValues: true },
    });
    cachedRepository = new DynamoRequestRepository(documentClient, tableName);
  }
  return cachedRepository;
}

/** Test seam: clears the memoised repository. */
export function resetRepository(): void {
  cachedRepository = undefined;
}
