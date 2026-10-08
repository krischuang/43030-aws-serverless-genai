/**
 * Minimal structured JSON logger.
 *
 * CloudWatch Logs Insights can query JSON fields directly, so emitting one JSON
 * object per line gives queryable telemetry without adding a logging dependency
 * to the Lambda bundle.
 *
 * Privacy rule enforced here: user prompt text is never a loggable field. Only
 * derived, non-reversible attributes (length, hash prefix) may be logged.
 */

import { createHash } from 'node:crypto';

/** SILENT is a threshold only; nothing is ever emitted at that level. */
export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'SILENT';

const LEVEL_ORDER: Record<LogLevel, number> = {
  DEBUG: 10,
  INFO: 20,
  WARN: 30,
  ERROR: 40,
  SILENT: 100,
};

/** Field names that must never reach the log stream. */
const DENIED_FIELDS = new Set([
  'prompt',
  'promptText',
  'completion',
  'response',
  'responseText',
  'authorization',
  'apikey',
  'apiKey',
  'token',
  'secret',
  'password',
  'credentials',
]);

export interface LogContext {
  [key: string]: unknown;
}

export interface LoggerOptions {
  readonly service: string;
  readonly operation: string;
  readonly requestId?: string;
  readonly correlationId?: string;
  readonly environment?: string;
  readonly level?: LogLevel;
}

/**
 * Removes denied keys and truncates long strings so that a caller mistake
 * cannot leak prompt content or credentials into CloudWatch.
 */
export function sanitise(context: LogContext): LogContext {
  const output: LogContext = {};
  for (const [key, value] of Object.entries(context)) {
    if (DENIED_FIELDS.has(key) || DENIED_FIELDS.has(key.toLowerCase())) {
      output[key] = '[redacted]';
      continue;
    }
    if (typeof value === 'string' && value.length > 256) {
      output[key] = `${value.slice(0, 256)}…[truncated]`;
      continue;
    }
    if (value instanceof Error) {
      output[key] = { name: value.name, message: value.message };
      continue;
    }
    output[key] = value;
  }
  return output;
}

/** Stable, non-reversible prompt identifier for correlating repeat prompts. */
export function fingerprint(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

export class Logger {
  private readonly base: Record<string, unknown>;
  private readonly threshold: number;

  constructor(options: LoggerOptions) {
    const level = options.level ?? (process.env.LOG_LEVEL as LogLevel | undefined) ?? 'INFO';
    this.threshold = LEVEL_ORDER[level] ?? LEVEL_ORDER.INFO;
    this.base = {
      service: options.service,
      operation: options.operation,
      environment: options.environment,
      requestId: options.requestId,
      correlationId: options.correlationId,
    };
  }

  /** Returns a child logger carrying additional immutable context. */
  child(extra: LogContext): Logger {
    const logger = Object.create(Logger.prototype) as Logger;
    Object.defineProperties(logger, {
      base: { value: { ...this.base, ...sanitise(extra) } },
      threshold: { value: this.threshold },
    });
    return logger;
  }

  debug(message: string, context: LogContext = {}): void {
    this.emit('DEBUG', message, context);
  }

  info(message: string, context: LogContext = {}): void {
    this.emit('INFO', message, context);
  }

  warn(message: string, context: LogContext = {}): void {
    this.emit('WARN', message, context);
  }

  error(message: string, context: LogContext = {}): void {
    this.emit('ERROR', message, context);
  }

  private emit(level: LogLevel, message: string, context: LogContext): void {
    if (LEVEL_ORDER[level] < this.threshold) {
      return;
    }
    const record = {
      level,
      message,
      timestamp: new Date().toISOString(),
      ...this.base,
      ...sanitise(context),
    };
    const line = JSON.stringify(record, (_key, value) => (value === undefined ? undefined : value));
    if (level === 'ERROR') {
      console.error(line);
    } else if (level === 'WARN') {
      console.warn(line);
    } else {
      console.log(line);
    }
  }
}
