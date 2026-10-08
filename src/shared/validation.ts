/**
 * Request validation and application-level AI safety checks.
 *
 * Validation runs before any Bedrock call so that malformed or abusive input is
 * rejected at the cheapest possible point. API Gateway also enforces a JSON
 * schema and a payload ceiling; these checks are the defence-in-depth layer
 * that still applies when the handler is invoked directly (tests, console,
 * future event sources).
 */

import { ValidationError } from './errors';

/** Hard ceiling on the raw request body, independent of prompt length. */
export const MAX_BODY_BYTES = 8 * 1024;

/** Minimum number of non-whitespace characters required in a prompt. */
export const MIN_PROMPT_LENGTH = 3;

export interface GenerateRequest {
  readonly prompt: string;
}

export interface ValidatedPrompt {
  readonly prompt: string;
  readonly promptLength: number;
  /** Non-blocking safety observations recorded with the request. */
  readonly safetyFlags: SafetyFlag[];
}

export type SafetyFlag = 'possible_prompt_injection' | 'possible_sensitive_data_request';

/**
 * Heuristics for instruction-override attempts. These are deliberately simple:
 * they annotate a request for evaluation and observability rather than acting
 * as a security boundary, which is documented in docs/security.md.
 */
const INJECTION_PATTERNS: RegExp[] = [
  /ignore\s+(all\s+)?(previous|prior|above)\s+(instructions|prompts|rules)/i,
  /disregard\s+(all\s+)?(previous|prior|your)\s+(instructions|rules|guidelines)/i,
  /you\s+are\s+now\s+(a|an|in)\s+/i,
  /reveal\s+(your\s+)?(system\s+prompt|instructions|hidden\s+rules)/i,
  /\bdeveloper\s+mode\b/i,
  /\bjailbreak\b/i,
];

/** Heuristics for requests that solicit credentials or personal data. */
const SENSITIVE_REQUEST_PATTERNS: RegExp[] = [
  /\b(aws)?\s*(secret|access)\s*key\b/i,
  /\bcredit\s*card\s*(number|details)\b/i,
  /\b(password|passphrase)s?\b/i,
  /\b(api|bearer)\s*token\b/i,
  /\b(tax\s*file\s*number|medicare\s*number|passport\s*number)\b/i,
];

/**
 * Control characters other than tab, newline and carriage return. Matching
 * control characters is the entire purpose of this expression, so the lint rule
 * that normally flags them is disabled for this line only.
 */
// eslint-disable-next-line no-control-regex
const DISALLOWED_CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

export function parseBody(rawBody: string | null | undefined, isBase64Encoded = false): unknown {
  if (rawBody === null || rawBody === undefined || rawBody === '') {
    throw new ValidationError('EMPTY_BODY', 'A JSON request body is required.');
  }

  const decoded = isBase64Encoded ? Buffer.from(rawBody, 'base64').toString('utf8') : rawBody;

  if (Buffer.byteLength(decoded, 'utf8') > MAX_BODY_BYTES) {
    throw new ValidationError(
      'BODY_TOO_LARGE',
      `Request body exceeds the ${MAX_BODY_BYTES} byte limit.`,
    );
  }

  try {
    return JSON.parse(decoded) as unknown;
  } catch {
    throw new ValidationError('MALFORMED_JSON', 'Request body must be valid JSON.');
  }
}

export function validateGenerateRequest(payload: unknown, maxPromptLength: number): ValidatedPrompt {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new ValidationError('INVALID_PAYLOAD', 'Request body must be a JSON object.');
  }

  const candidate = (payload as Record<string, unknown>).prompt;

  if (candidate === undefined) {
    throw new ValidationError('MISSING_PROMPT', 'Field "prompt" is required.');
  }
  if (typeof candidate !== 'string') {
    throw new ValidationError('INVALID_PROMPT_TYPE', 'Field "prompt" must be a string.');
  }

  const prompt = candidate.trim();

  if (prompt.length === 0) {
    throw new ValidationError('EMPTY_PROMPT', 'Field "prompt" must not be empty.');
  }
  if (prompt.length < MIN_PROMPT_LENGTH) {
    throw new ValidationError(
      'PROMPT_TOO_SHORT',
      `Field "prompt" must contain at least ${MIN_PROMPT_LENGTH} characters.`,
    );
  }
  if (prompt.length > maxPromptLength) {
    throw new ValidationError(
      'PROMPT_TOO_LONG',
      `Field "prompt" must not exceed ${maxPromptLength} characters.`,
    );
  }
  if (DISALLOWED_CONTROL_CHARS.test(prompt)) {
    throw new ValidationError(
      'INVALID_CHARACTERS',
      'Field "prompt" contains unsupported control characters.',
    );
  }

  return {
    prompt,
    promptLength: prompt.length,
    safetyFlags: detectSafetyFlags(prompt),
  };
}

export function detectSafetyFlags(prompt: string): SafetyFlag[] {
  const flags: SafetyFlag[] = [];
  if (INJECTION_PATTERNS.some((pattern) => pattern.test(prompt))) {
    flags.push('possible_prompt_injection');
  }
  if (SENSITIVE_REQUEST_PATTERNS.some((pattern) => pattern.test(prompt))) {
    flags.push('possible_sensitive_data_request');
  }
  return flags;
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Validates the path parameter before it reaches DynamoDB, so an unexpected
 * value can never be used to probe the table.
 */
export function validateRequestId(value: string | undefined): string {
  if (value === undefined || value.trim() === '') {
    throw new ValidationError('MISSING_REQUEST_ID', 'Path parameter "requestId" is required.');
  }
  const requestId = value.trim();
  if (!UUID_V4.test(requestId)) {
    throw new ValidationError('INVALID_REQUEST_ID', 'Path parameter "requestId" must be a UUID.');
  }
  return requestId;
}
