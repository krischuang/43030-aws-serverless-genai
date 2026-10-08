/**
 * POST /generate
 *
 * Validates the caller's prompt, invokes Amazon Bedrock, records non-sensitive
 * metadata in DynamoDB and returns the generated text. Failures are recorded
 * on a best-effort basis so that error rates are observable in the data store
 * as well as in CloudWatch.
 */

import { randomUUID } from 'node:crypto';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getGenerationClient } from '../shared/bedrock';
import { loadConfig } from '../shared/config';
import { AppError, toAppError } from '../shared/errors';
import { errorResponse, jsonResponse } from '../shared/http';
import { Logger, fingerprint } from '../shared/logger';
import { getRepository, ttlFromNow, type RequestRecord, type RequestStatus } from '../shared/repository';
import { parseBody, validateGenerateRequest } from '../shared/validation';

const SERVICE_NAME = 'serverless-genai';
const OPERATION = 'generate';

export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const startedAt = Date.now();
  const requestId = randomUUID();
  let logger = new Logger({
    service: SERVICE_NAME,
    operation: OPERATION,
    requestId,
    correlationId: event.requestContext?.requestId,
  });

  try {
    const config = loadConfig();
    logger = logger.child({ environment: config.environmentName, modelId: config.modelId });

    const payload = parseBody(event.body, event.isBase64Encoded ?? false);
    const validated = validateGenerateRequest(payload, config.maxPromptLength);

    logger.info('request accepted', {
      promptLength: validated.promptLength,
      promptFingerprint: fingerprint(validated.prompt),
      safetyFlags: validated.safetyFlags,
      guardrailEnabled: config.guardrailId !== undefined,
    });

    const generation = await getGenerationClient(config.mockBedrock).generate({
      prompt: validated.prompt,
      modelId: config.modelId,
      maxOutputTokens: config.maxOutputTokens,
      temperature: config.temperature,
      guardrailId: config.guardrailId,
      guardrailVersion: config.guardrailVersion,
    });

    const createdAt = new Date().toISOString();
    const latencyMs = Date.now() - startedAt;

    const record: RequestRecord = {
      requestId,
      createdAt,
      status: 'succeeded',
      modelId: generation.modelId,
      environment: config.environmentName,
      promptLength: validated.promptLength,
      promptFingerprint: fingerprint(validated.prompt),
      safetyFlags: validated.safetyFlags,
      responseText: generation.text,
      stopReason: generation.stopReason,
      inputTokens: generation.inputTokens,
      outputTokens: generation.outputTokens,
      latencyMs,
      ttl: ttlFromNow(config.recordTtlDays),
    };

    await getRepository(config.tableName).put(record);

    logger.info('request completed', {
      status: 'succeeded',
      durationMs: latencyMs,
      modelLatencyMs: generation.modelLatencyMs,
      inputTokens: generation.inputTokens,
      outputTokens: generation.outputTokens,
      stopReason: generation.stopReason,
      responseLength: generation.text.length,
    });

    return jsonResponse(200, {
      requestId,
      response: generation.text,
      modelId: generation.modelId,
      createdAt,
      metadata: {
        latencyMs,
        stopReason: generation.stopReason,
        inputTokens: generation.inputTokens,
        outputTokens: generation.outputTokens,
        safetyFlags: validated.safetyFlags,
        mode: config.mockBedrock ? 'mock' : 'live',
      },
    });
  } catch (error) {
    const appError = toAppError(error);
    const durationMs = Date.now() - startedAt;

    logger.error('request failed', {
      status: 'failed',
      errorCategory: appError.category,
      errorCode: appError.code,
      statusCode: appError.statusCode,
      durationMs,
      detail: appError.message,
    });

    await recordFailure(appError, requestId, durationMs, logger);

    return errorResponse(appError, requestId);
  }
}

/**
 * Persists a failure record where it is useful and safe to do so. Validation
 * rejections are not persisted: they never reached the model, and writing them
 * would let an unauthenticated-shaped request inflate the table.
 */
async function recordFailure(
  appError: AppError,
  requestId: string,
  durationMs: number,
  logger: Logger,
): Promise<void> {
  if (appError.category === 'validation' || appError.category === 'configuration') {
    return;
  }

  try {
    const config = loadConfig();
    const status: RequestStatus = appError.category === 'content_blocked' ? 'blocked' : 'failed';
    await getRepository(config.tableName).put({
      requestId,
      createdAt: new Date().toISOString(),
      status,
      modelId: config.modelId,
      environment: config.environmentName,
      promptLength: 0,
      promptFingerprint: 'not-recorded',
      safetyFlags: [],
      errorCode: appError.code,
      latencyMs: durationMs,
      ttl: ttlFromNow(config.recordTtlDays),
    });
  } catch (persistenceError) {
    // Never allow failure bookkeeping to replace the original error.
    logger.warn('failure record could not be persisted', {
      errorCategory: 'persistence',
      detail: persistenceError instanceof Error ? persistenceError.message : 'unknown',
    });
  }
}
