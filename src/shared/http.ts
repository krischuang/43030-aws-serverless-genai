/**
 * API Gateway response helpers. Centralising response construction keeps
 * headers and error shapes consistent across handlers.
 */

import type { APIGatewayProxyResult } from 'aws-lambda';
import { AppError, SafeErrorBody } from './errors';

const BASE_HEADERS: Record<string, string> = {
  'content-type': 'application/json',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
};

export function jsonResponse(
  statusCode: number,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): APIGatewayProxyResult {
  return {
    statusCode,
    headers: { ...BASE_HEADERS, ...extraHeaders },
    body: JSON.stringify(body),
  };
}

/** Serialises an AppError into a response containing no internal detail. */
export function errorResponse(error: AppError, requestId?: string): APIGatewayProxyResult {
  const body: SafeErrorBody = {
    error: { code: error.code, message: error.clientMessage },
    ...(requestId ? { requestId } : {}),
  };
  return jsonResponse(error.statusCode, body);
}
