import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ConverseCommandOutput,
} from '@aws-sdk/client-bedrock-runtime';
import { mockClient } from 'aws-sdk-client-mock';
import {
  BedrockGenerationClient,
  MockGenerationClient,
  SYSTEM_PROMPT,
  getGenerationClient,
  resetGenerationClient,
} from '../src/shared/bedrock';
import { ContentBlockedError, UpstreamModelError } from '../src/shared/errors';

const bedrockMock = mockClient(BedrockRuntimeClient);

const request = {
  prompt: 'Explain serverless computing in one paragraph.',
  modelId: 'apac.amazon.nova-micro-v1:0',
  maxOutputTokens: 400,
  temperature: 0.2,
};

function converseOutput(overrides: Partial<ConverseCommandOutput> = {}): ConverseCommandOutput {
  return {
    $metadata: {},
    stopReason: 'end_turn',
    output: { message: { role: 'assistant', content: [{ text: 'Serverless means no servers.' }] } },
    usage: { inputTokens: 12, outputTokens: 7, totalTokens: 19 },
    metrics: { latencyMs: 410 },
    ...overrides,
  } as ConverseCommandOutput;
}

describe('BedrockGenerationClient', () => {
  beforeEach(() => {
    bedrockMock.reset();
    resetGenerationClient();
  });

  it('returns generated text and usage metadata on success', async () => {
    bedrockMock.on(ConverseCommand).resolves(converseOutput());

    const client = new BedrockGenerationClient(new BedrockRuntimeClient({}));
    const result = await client.generate(request);

    expect(result.text).toBe('Serverless means no servers.');
    expect(result.modelId).toBe(request.modelId);
    expect(result.stopReason).toBe('end_turn');
    expect(result.inputTokens).toBe(12);
    expect(result.outputTokens).toBe(7);
    expect(result.modelLatencyMs).toBe(410);
    expect(result.guardrailIntervened).toBe(false);
  });

  it('sends the pinned system prompt and conservative inference limits', async () => {
    bedrockMock.on(ConverseCommand).resolves(converseOutput());

    await new BedrockGenerationClient(new BedrockRuntimeClient({})).generate(request);

    const calls = bedrockMock.commandCalls(ConverseCommand);
    expect(calls).toHaveLength(1);
    const input = calls[0].args[0].input;
    expect(input.modelId).toBe(request.modelId);
    expect(input.system).toEqual([{ text: SYSTEM_PROMPT }]);
    expect(input.inferenceConfig).toEqual({ maxTokens: 400, temperature: 0.2 });
    expect(input.guardrailConfig).toBeUndefined();
  });

  it('attaches the guardrail configuration when one is provided', async () => {
    bedrockMock.on(ConverseCommand).resolves(converseOutput());

    await new BedrockGenerationClient(new BedrockRuntimeClient({})).generate({
      ...request,
      guardrailId: 'gr-123',
      guardrailVersion: '1',
    });

    const input = bedrockMock.commandCalls(ConverseCommand)[0].args[0].input;
    expect(input.guardrailConfig).toEqual({
      guardrailIdentifier: 'gr-123',
      guardrailVersion: '1',
    });
  });

  it('raises a content-blocked error when the guardrail intervenes', async () => {
    bedrockMock.on(ConverseCommand).resolves(
      converseOutput({
        stopReason: 'guardrail_intervened',
        output: { message: { role: 'assistant', content: [{ text: 'blocked' }] } },
      }),
    );

    const client = new BedrockGenerationClient(new BedrockRuntimeClient({}));
    await expect(client.generate(request)).rejects.toBeInstanceOf(ContentBlockedError);
  });

  it('raises an upstream error when the model returns no text', async () => {
    bedrockMock.on(ConverseCommand).resolves(
      converseOutput({ output: { message: { role: 'assistant', content: [] } } }),
    );

    const client = new BedrockGenerationClient(new BedrockRuntimeClient({}));
    await expect(client.generate(request)).rejects.toBeInstanceOf(UpstreamModelError);
  });

  it('classifies an access-denied failure as a configuration fault without leaking it', async () => {
    const denied = Object.assign(new Error('not authorised'), { name: 'AccessDeniedException' });
    bedrockMock.on(ConverseCommand).rejects(denied);

    const client = new BedrockGenerationClient(new BedrockRuntimeClient({}));
    const error = await client.generate(request).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(UpstreamModelError);
    const upstream = error as UpstreamModelError;
    expect(upstream.statusCode).toBe(502);
    expect(upstream.message).toContain('configuration');
    // The caller-facing message must not reveal the underlying AWS detail.
    expect(upstream.clientMessage).not.toContain('AccessDenied');
    expect(upstream.clientMessage).not.toContain('not authorised');
  });

  it('classifies a throttling failure as transient', async () => {
    const throttled = Object.assign(new Error('slow down'), { name: 'ThrottlingException' });
    bedrockMock.on(ConverseCommand).rejects(throttled);

    const client = new BedrockGenerationClient(new BedrockRuntimeClient({}));
    const error = (await client.generate(request).catch((e: unknown) => e)) as UpstreamModelError;

    expect(error.message).toContain('transient');
    expect(error.code).toBe('MODEL_UNAVAILABLE');
  });
});

describe('MockGenerationClient', () => {
  it('returns deterministic text that is clearly labelled as mock output', async () => {
    const result = await new MockGenerationClient().generate(request);

    expect(result.text).toContain('[mock-mode]');
    expect(result.modelId).toContain('(mock)');
    expect(result.stopReason).toBe('end_turn');
  });
});

describe('getGenerationClient', () => {
  beforeEach(() => resetGenerationClient());

  it('returns the mock client when mock mode is requested', () => {
    expect(getGenerationClient(true)).toBeInstanceOf(MockGenerationClient);
  });

  it('returns the Bedrock client otherwise and memoises it', () => {
    const first = getGenerationClient(false);
    expect(first).toBeInstanceOf(BedrockGenerationClient);
    expect(getGenerationClient(false)).toBe(first);
  });
});
