import { ConfigurationError, loadConfig } from '../src/shared/config';
import { AppError, NotFoundError, toAppError } from '../src/shared/errors';
import { errorResponse, jsonResponse } from '../src/shared/http';
import { Logger, fingerprint, sanitise } from '../src/shared/logger';

const originalEnv = process.env;

afterEach(() => {
  process.env = originalEnv;
});

describe('sanitise', () => {
  it('redacts prompt and credential fields', () => {
    const output = sanitise({
      prompt: 'sensitive user text',
      response: 'model output',
      authorization: 'Bearer abc',
      apiKey: 'secret-value',
      promptLength: 19,
    });

    expect(output).toEqual({
      prompt: '[redacted]',
      response: '[redacted]',
      authorization: '[redacted]',
      apiKey: '[redacted]',
      promptLength: 19,
    });
  });

  it('truncates long strings', () => {
    const output = sanitise({ detail: 'x'.repeat(400) }) as { detail: string };
    expect(output.detail).toHaveLength(256 + '…[truncated]'.length);
    expect(output.detail.endsWith('…[truncated]')).toBe(true);
  });

  it('reduces errors to name and message', () => {
    const output = sanitise({ cause: new TypeError('bad input') });
    expect(output.cause).toEqual({ name: 'TypeError', message: 'bad input' });
  });
});

describe('fingerprint', () => {
  it('is deterministic, short and not reversible to the input', () => {
    const value = fingerprint('Explain serverless computing.');
    expect(value).toHaveLength(12);
    expect(value).toMatch(/^[0-9a-f]{12}$/);
    expect(fingerprint('Explain serverless computing.')).toBe(value);
    expect(fingerprint('Explain serverless computing!')).not.toBe(value);
  });
});

describe('Logger', () => {
  function capture(): { lines: string[]; restore: () => void } {
    const lines: string[] = [];
    const spies = [
      jest.spyOn(console, 'log').mockImplementation((line: unknown) => lines.push(String(line))),
      jest.spyOn(console, 'warn').mockImplementation((line: unknown) => lines.push(String(line))),
      jest.spyOn(console, 'error').mockImplementation((line: unknown) => lines.push(String(line))),
    ];
    return { lines, restore: () => spies.forEach((spy) => spy.mockRestore()) };
  }

  it('emits one JSON object per line with correlation fields', () => {
    const captured = capture();
    const logger = new Logger({
      service: 'serverless-genai',
      operation: 'generate',
      requestId: 'req-1',
      correlationId: 'corr-1',
      environment: 'test',
    });

    logger.info('request accepted', { promptLength: 12 });
    captured.restore();

    expect(captured.lines).toHaveLength(1);
    const entry = JSON.parse(captured.lines[0]);
    expect(entry).toMatchObject({
      level: 'INFO',
      message: 'request accepted',
      service: 'serverless-genai',
      operation: 'generate',
      requestId: 'req-1',
      correlationId: 'corr-1',
      environment: 'test',
      promptLength: 12,
    });
    expect(Date.parse(entry.timestamp)).not.toBeNaN();
  });

  it('suppresses entries below the configured level', () => {
    const captured = capture();
    const logger = new Logger({ service: 's', operation: 'o', level: 'WARN' });

    logger.debug('ignored');
    logger.info('ignored');
    logger.warn('kept');
    logger.error('kept');
    captured.restore();

    expect(captured.lines).toHaveLength(2);
    expect(captured.lines.map((line) => JSON.parse(line).level)).toEqual(['WARN', 'ERROR']);
  });

  it('carries child context into every subsequent entry', () => {
    const captured = capture();
    const logger = new Logger({ service: 's', operation: 'o' }).child({ modelId: 'model-x' });

    logger.info('first');
    logger.info('second');
    captured.restore();

    expect(captured.lines.map((line) => JSON.parse(line).modelId)).toEqual(['model-x', 'model-x']);
  });

  it('redacts denied fields passed by a caller', () => {
    const captured = capture();
    new Logger({ service: 's', operation: 'o' }).info('oops', { prompt: 'leaky text' });
    captured.restore();

    expect(captured.lines[0]).not.toContain('leaky text');
    expect(JSON.parse(captured.lines[0]).prompt).toBe('[redacted]');
  });
});

describe('http responses', () => {
  it('sets conservative security headers', () => {
    const response = jsonResponse(200, { ok: true });
    expect(response.headers).toMatchObject({
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
  });

  it('serialises only the safe fields of an error', () => {
    const error = new AppError({
      code: 'MODEL_UNAVAILABLE',
      statusCode: 502,
      category: 'upstream_model',
      clientMessage: 'The language model could not be reached.',
      internalMessage: 'AccessDeniedException: role arn:aws:iam::123:role/x is not authorised',
    });

    const response = errorResponse(error, 'req-1');

    expect(response.statusCode).toBe(502);
    expect(JSON.parse(response.body)).toEqual({
      error: { code: 'MODEL_UNAVAILABLE', message: 'The language model could not be reached.' },
      requestId: 'req-1',
    });
    expect(response.body).not.toContain('AccessDenied');
    expect(response.body).not.toContain('arn:aws:iam');
  });
});

describe('toAppError', () => {
  it('passes through an existing AppError', () => {
    const original = new NotFoundError();
    expect(toAppError(original)).toBe(original);
  });

  it('wraps an unknown error as a generic internal failure', () => {
    const wrapped = toAppError(new Error('mysterious internal detail'));
    expect(wrapped.statusCode).toBe(500);
    expect(wrapped.code).toBe('INTERNAL_ERROR');
    expect(wrapped.clientMessage).toBe('An unexpected error occurred.');
    expect(wrapped.message).toContain('mysterious internal detail');
  });

  it('wraps a non-error throw', () => {
    expect(toAppError('a string failure').category).toBe('internal');
  });
});

describe('loadConfig', () => {
  it('reads configuration from the environment and applies defaults', () => {
    process.env = {
      ...originalEnv,
      TABLE_NAME: 'table',
      BEDROCK_MODEL_ID: 'model',
    };

    expect(loadConfig()).toMatchObject({
      tableName: 'table',
      modelId: 'model',
      maxPromptLength: 2000,
      maxOutputTokens: 400,
      recordTtlDays: 7,
      environmentName: 'dev',
      mockBedrock: false,
      guardrailId: undefined,
    });
  });

  it('fails fast when a required variable is absent', () => {
    process.env = { ...originalEnv, BEDROCK_MODEL_ID: 'model' };
    delete process.env.TABLE_NAME;

    expect(() => loadConfig()).toThrow(ConfigurationError);
  });

  it('rejects a non-numeric numeric variable', () => {
    process.env = {
      ...originalEnv,
      TABLE_NAME: 'table',
      BEDROCK_MODEL_ID: 'model',
      MAX_PROMPT_LENGTH: 'not-a-number',
    };

    expect(() => loadConfig()).toThrow(ConfigurationError);
  });

  it('exposes guardrail settings when both id and version are present', () => {
    process.env = {
      ...originalEnv,
      TABLE_NAME: 'table',
      BEDROCK_MODEL_ID: 'model',
      GUARDRAIL_ID: 'gr-1',
      GUARDRAIL_VERSION: '2',
    };

    expect(loadConfig()).toMatchObject({ guardrailId: 'gr-1', guardrailVersion: '2' });
  });
});
