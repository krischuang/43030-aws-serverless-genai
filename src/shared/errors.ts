/**
 * Application error taxonomy.
 *
 * Every error carries a stable machine-readable code, an HTTP status and a
 * message that is explicitly safe to return to the caller. Internal detail
 * (stack traces, AWS error strings, resource names) stays in CloudWatch and is
 * never serialised into an API response.
 */

export type ErrorCategory =
  | 'validation'
  | 'not_found'
  | 'content_blocked'
  | 'upstream_model'
  | 'persistence'
  | 'configuration'
  | 'internal';

export interface SafeErrorBody {
  readonly error: {
    readonly code: string;
    readonly message: string;
  };
  readonly requestId?: string;
}

export class AppError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly category: ErrorCategory;
  /** Message considered safe for the API consumer. */
  readonly clientMessage: string;

  constructor(params: {
    code: string;
    statusCode: number;
    category: ErrorCategory;
    clientMessage: string;
    internalMessage?: string;
  }) {
    super(params.internalMessage ?? params.clientMessage);
    this.name = 'AppError';
    this.code = params.code;
    this.statusCode = params.statusCode;
    this.category = params.category;
    this.clientMessage = params.clientMessage;
  }
}

export class ValidationError extends AppError {
  constructor(code: string, clientMessage: string) {
    super({ code, statusCode: 400, category: 'validation', clientMessage });
    this.name = 'ValidationError';
  }
}

export class NotFoundError extends AppError {
  constructor(clientMessage = 'Request record not found.') {
    super({ code: 'NOT_FOUND', statusCode: 404, category: 'not_found', clientMessage });
    this.name = 'NotFoundError';
  }
}

export class ContentBlockedError extends AppError {
  constructor(clientMessage = 'The request was blocked by the configured content policy.') {
    super({
      code: 'CONTENT_BLOCKED',
      statusCode: 422,
      category: 'content_blocked',
      clientMessage,
    });
    this.name = 'ContentBlockedError';
  }
}

export class UpstreamModelError extends AppError {
  constructor(internalMessage: string) {
    super({
      code: 'MODEL_UNAVAILABLE',
      statusCode: 502,
      category: 'upstream_model',
      clientMessage: 'The language model could not be reached. Please retry shortly.',
      internalMessage,
    });
    this.name = 'UpstreamModelError';
  }
}

export class PersistenceError extends AppError {
  constructor(internalMessage: string) {
    super({
      code: 'PERSISTENCE_FAILURE',
      statusCode: 503,
      category: 'persistence',
      clientMessage: 'The request could not be recorded. Please retry shortly.',
      internalMessage,
    });
    this.name = 'PersistenceError';
  }
}

/** Normalises any thrown value into an AppError without leaking internals. */
export function toAppError(error: unknown): AppError {
  if (error instanceof AppError) {
    return error;
  }
  const internalMessage = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return new AppError({
    code: 'INTERNAL_ERROR',
    statusCode: 500,
    category: 'internal',
    clientMessage: 'An unexpected error occurred.',
    internalMessage,
  });
}
