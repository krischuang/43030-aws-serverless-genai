/**
 * Runtime configuration resolved from environment variables that are injected
 * by the CDK stack. No secrets are read here: every value is non-sensitive
 * configuration, which keeps the Lambda free of hard-coded settings while
 * avoiding any need for a secret store in this project.
 */

export interface AppConfig {
  readonly tableName: string;
  readonly modelId: string;
  readonly maxPromptLength: number;
  readonly maxOutputTokens: number;
  readonly temperature: number;
  readonly recordTtlDays: number;
  readonly guardrailId?: string;
  readonly guardrailVersion?: string;
  readonly environmentName: string;
  readonly mockBedrock: boolean;
}

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigurationError';
  }
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') {
    throw new ConfigurationError(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optionalEnv(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value.trim() === '' ? undefined : value;
}

function numberEnv(name: string, fallback: number): number {
  const raw = optionalEnv(name);
  if (raw === undefined) {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new ConfigurationError(`Environment variable ${name} must be numeric, received "${raw}"`);
  }
  return parsed;
}

/**
 * Reads configuration on every invocation rather than at module scope so that
 * tests can vary the environment and so a configuration fault surfaces as a
 * handled error instead of a Lambda init crash.
 */
export function loadConfig(): AppConfig {
  const guardrailId = optionalEnv('GUARDRAIL_ID');
  const guardrailVersion = optionalEnv('GUARDRAIL_VERSION');

  return {
    tableName: requireEnv('TABLE_NAME'),
    modelId: requireEnv('BEDROCK_MODEL_ID'),
    maxPromptLength: numberEnv('MAX_PROMPT_LENGTH', 2000),
    maxOutputTokens: numberEnv('BEDROCK_MAX_OUTPUT_TOKENS', 400),
    temperature: numberEnv('BEDROCK_TEMPERATURE', 0.2),
    recordTtlDays: numberEnv('RECORD_TTL_DAYS', 7),
    guardrailId,
    guardrailVersion,
    environmentName: optionalEnv('ENVIRONMENT_NAME') ?? 'dev',
    mockBedrock: optionalEnv('MOCK_BEDROCK') === 'true',
  };
}
