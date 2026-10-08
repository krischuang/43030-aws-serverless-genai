/**
 * Transports for the evaluation harness.
 *
 * Mock transport  — runs the real handler code in-process with the AWS SDK
 *                   clients stubbed. It validates routing, validation, safety
 *                   flagging and persistence logic with no AWS account and no
 *                   cost. Model output is canned, so response-quality
 *                   dimensions are reported as skipped rather than passed.
 *
 * Live transport  — sends SigV4-signed HTTPS requests to the deployed,
 *                   IAM-authorised API Gateway endpoint. Results from this
 *                   transport are the only ones that may be presented as live
 *                   Bedrock evidence.
 */

import { Sha256 } from '@aws-crypto/sha256-js';
import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { HttpRequest } from '@smithy/protocol-http';
import { SignatureV4 } from '@smithy/signature-v4';
import { mockClient } from 'aws-sdk-client-mock';
import type { APIGatewayProxyEvent } from 'aws-lambda';
import { handler as generateHandler } from '../src/handlers/generate';
import { handler as getRequestHandler } from '../src/handlers/get-request';
import { resetGenerationClient } from '../src/shared/bedrock';
import { resetRepository } from '../src/shared/repository';
import type { ApiResponse, EvaluationTransport } from './types';

const CANNED_MODEL_TEXT =
  'Stubbed model output used by the mock transport. Response-quality dimensions are not scored in this mode.';

export class MockTransport implements EvaluationTransport {
  readonly mode = 'mock' as const;

  private readonly bedrockMock = mockClient(BedrockRuntimeClient);
  private readonly documentMock = mockClient(DynamoDBDocumentClient);
  private readonly store = new Map<string, Record<string, unknown>>();
  private callSequence = 0;

  constructor(modelId: string) {
    process.env.TABLE_NAME = 'evaluation-mock-table';
    process.env.BEDROCK_MODEL_ID = modelId;
    process.env.MAX_PROMPT_LENGTH = process.env.MAX_PROMPT_LENGTH ?? '2000';
    process.env.RECORD_TTL_DAYS = process.env.RECORD_TTL_DAYS ?? '7';
    process.env.ENVIRONMENT_NAME = 'evaluation';
    // The handlers log on every path; the report, not the console, is the
    // artefact here.
    process.env.LOG_LEVEL = 'SILENT';
    delete process.env.MOCK_BEDROCK;

    this.bedrockMock.on(ConverseCommand).resolves({
      $metadata: {},
      stopReason: 'end_turn',
      output: { message: { role: 'assistant', content: [{ text: CANNED_MODEL_TEXT }] } },
      usage: { inputTokens: 20, outputTokens: 18, totalTokens: 38 },
      metrics: { latencyMs: 0 },
    });

    this.documentMock.on(PutCommand).callsFake((input: { Item: Record<string, unknown> }) => {
      this.store.set(String(input.Item.requestId), input.Item);
      return {};
    });

    this.documentMock.on(GetCommand).callsFake((input: { Key: { requestId: string } }) => {
      const item = this.store.get(input.Key.requestId);
      return item === undefined ? {} : { Item: item };
    });
  }

  /** Counts real ConverseCommand calls, so "no model invocation" is observable. */
  modelInvocations(): number {
    return this.bedrockMock.commandCalls(ConverseCommand).length;
  }

  resetCounters(): void {
    this.bedrockMock.resetHistory();
    resetGenerationClient();
    resetRepository();
  }

  async generate(body: string): Promise<ApiResponse> {
    const event = {
      body,
      isBase64Encoded: false,
      requestContext: { requestId: `mock-${(this.callSequence += 1)}` },
    } as unknown as APIGatewayProxyEvent;

    const response = await generateHandler(event);
    return { statusCode: response.statusCode, body: safeJson(response.body) };
  }

  async retrieve(requestId: string): Promise<ApiResponse> {
    const event = {
      pathParameters: { requestId },
      requestContext: { requestId: `mock-get-${requestId}` },
    } as unknown as APIGatewayProxyEvent;

    const response = await getRequestHandler(event);
    return { statusCode: response.statusCode, body: safeJson(response.body) };
  }
}

export class LiveTransport implements EvaluationTransport {
  readonly mode = 'live' as const;
  private readonly signer: SignatureV4;
  private readonly base: URL;

  constructor(apiBaseUrl: string, region: string) {
    this.base = new URL(apiBaseUrl.endsWith('/') ? apiBaseUrl : `${apiBaseUrl}/`);
    this.signer = new SignatureV4({
      service: 'execute-api',
      region,
      credentials: fromNodeProviderChain(),
      sha256: Sha256,
    });
  }

  async generate(body: string): Promise<ApiResponse> {
    return this.send('POST', 'generate', body);
  }

  async retrieve(requestId: string): Promise<ApiResponse> {
    return this.send('GET', `requests/${requestId}`);
  }

  private async send(method: 'GET' | 'POST', route: string, body?: string): Promise<ApiResponse> {
    const url = new URL(route, this.base);

    const request = new HttpRequest({
      method,
      protocol: url.protocol,
      hostname: url.hostname,
      path: url.pathname,
      headers: {
        host: url.hostname,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body }),
    });

    const signed = await this.signer.sign(request);

    const response = await fetch(url.toString(), {
      method,
      headers: signed.headers as Record<string, string>,
      ...(body === undefined ? {} : { body }),
    });

    const text = await response.text();
    return { statusCode: response.status, body: safeJson(text) };
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { raw: text };
  }
}
