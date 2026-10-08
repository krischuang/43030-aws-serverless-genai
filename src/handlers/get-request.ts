/**
 * GET /requests/{requestId}
 *
 * Returns a previously stored request record. The response is assembled field
 * by field rather than returned verbatim, so internal attributes (TTL, prompt
 * fingerprint) are never exposed to the caller.
 */

import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { loadConfig } from '../shared/config';
import { NotFoundError, toAppError } from '../shared/errors';
import { errorResponse, jsonResponse } from '../shared/http';
import { Logger } from '../shared/logger';
import { getRepository } from '../shared/repository';
import { validateRequestId } from '../shared/validation';

const SERVICE_NAME = 'serverless-genai';
const OPERATION = 'get-request';

export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const startedAt = Date.now();
  let logger = new Logger({
    service: SERVICE_NAME,
    operation: OPERATION,
    correlationId: event.requestContext?.requestId,
  });

  try {
    const config = loadConfig();
    const requestId = validateRequestId(event.pathParameters?.requestId);
    logger = logger.child({ requestId, environment: config.environmentName });

    const record = await getRepository(config.tableName).get(requestId);

    if (record === undefined) {
      throw new NotFoundError();
    }

    const durationMs = Date.now() - startedAt;
    logger.info('request retrieved', {
      status: 'succeeded',
      recordStatus: record.status,
      durationMs,
    });

    return jsonResponse(200, {
      requestId: record.requestId,
      status: record.status,
      response: record.responseText ?? null,
      modelId: record.modelId,
      createdAt: record.createdAt,
      metadata: {
        promptLength: record.promptLength,
        safetyFlags: record.safetyFlags ?? [],
        stopReason: record.stopReason,
        inputTokens: record.inputTokens,
        outputTokens: record.outputTokens,
        latencyMs: record.latencyMs,
        errorCode: record.errorCode,
      },
    });
  } catch (error) {
    const appError = toAppError(error);
    logger.error('retrieval failed', {
      status: 'failed',
      errorCategory: appError.category,
      errorCode: appError.code,
      statusCode: appError.statusCode,
      durationMs: Date.now() - startedAt,
      detail: appError.message,
    });
    return errorResponse(appError);
  }
}
