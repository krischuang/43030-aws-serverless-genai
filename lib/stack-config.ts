/**
 * Stack configuration resolved from CDK context (cdk.json, or -c overrides on
 * the command line). Keeping every tunable value here means the stack has no
 * hard-coded environment assumptions and can be synthesised for a different
 * region, model or retention policy without editing construct code.
 */

import type { Construct } from 'constructs';

export interface StackSettings {
  readonly projectName: string;
  readonly environmentName: string;
  readonly bedrockModelId: string;
  readonly bedrockMaxOutputTokens: number;
  readonly bedrockTemperature: number;
  readonly maxPromptLength: number;
  readonly recordTtlDays: number;
  readonly enableGuardrail: boolean;
  readonly logRetentionDays: number;
  readonly apiThrottleRateLimit: number;
  readonly apiThrottleBurstLimit: number;
  /**
   * When true the Lambda returns deterministic placeholder text instead of
   * calling Bedrock. Intended only for accounts without Bedrock model access.
   */
  readonly mockBedrock: boolean;
}

const DEFAULTS: StackSettings = {
  projectName: '43030-ServerlessGenAI',
  environmentName: 'dev',
  bedrockModelId: 'apac.amazon.nova-micro-v1:0',
  bedrockMaxOutputTokens: 400,
  bedrockTemperature: 0.2,
  maxPromptLength: 2000,
  recordTtlDays: 7,
  enableGuardrail: true,
  logRetentionDays: 7,
  apiThrottleRateLimit: 5,
  apiThrottleBurstLimit: 10,
  mockBedrock: false,
};

function contextString(scope: Construct, key: string, fallback: string): string {
  const value = scope.node.tryGetContext(key);
  return typeof value === 'string' && value.trim() !== '' ? value : fallback;
}

function contextNumber(scope: Construct, key: string, fallback: number): number {
  const value = scope.node.tryGetContext(key);
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`CDK context "${key}" must be numeric, received "${String(value)}"`);
  }
  return parsed;
}

function contextBoolean(scope: Construct, key: string, fallback: boolean): boolean {
  const value = scope.node.tryGetContext(key);
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  return String(value).toLowerCase() === 'true';
}

export function resolveSettings(scope: Construct): StackSettings {
  return {
    projectName: contextString(scope, 'projectName', DEFAULTS.projectName),
    environmentName: contextString(scope, 'environmentName', DEFAULTS.environmentName),
    bedrockModelId: contextString(scope, 'bedrockModelId', DEFAULTS.bedrockModelId),
    bedrockMaxOutputTokens: contextNumber(
      scope,
      'bedrockMaxOutputTokens',
      DEFAULTS.bedrockMaxOutputTokens,
    ),
    bedrockTemperature: contextNumber(scope, 'bedrockTemperature', DEFAULTS.bedrockTemperature),
    maxPromptLength: contextNumber(scope, 'maxPromptLength', DEFAULTS.maxPromptLength),
    recordTtlDays: contextNumber(scope, 'recordTtlDays', DEFAULTS.recordTtlDays),
    enableGuardrail: contextBoolean(scope, 'enableGuardrail', DEFAULTS.enableGuardrail),
    logRetentionDays: contextNumber(scope, 'logRetentionDays', DEFAULTS.logRetentionDays),
    apiThrottleRateLimit: contextNumber(
      scope,
      'apiThrottleRateLimit',
      DEFAULTS.apiThrottleRateLimit,
    ),
    apiThrottleBurstLimit: contextNumber(
      scope,
      'apiThrottleBurstLimit',
      DEFAULTS.apiThrottleBurstLimit,
    ),
    mockBedrock: contextBoolean(scope, 'mockBedrock', DEFAULTS.mockBedrock),
  };
}
