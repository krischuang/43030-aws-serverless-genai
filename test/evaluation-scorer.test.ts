import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { scoreCase } from '../evaluation/scorer';
import type { CaseSuite, EvaluationCase } from '../evaluation/types';

const suite = JSON.parse(
  readFileSync(join(__dirname, '..', 'evaluation', 'cases.json'), 'utf8'),
) as CaseSuite;

function verdictFor(result: ReturnType<typeof scoreCase>, dimension: string): string | undefined {
  return result.dimensions.find((entry) => entry.dimension === dimension)?.verdict;
}

describe('evaluation suite definition', () => {
  it('declares between 8 and 15 cases with unique ids', () => {
    const ids = suite.cases.map((testCase) => testCase.id);
    expect(ids.length).toBeGreaterThanOrEqual(8);
    expect(ids.length).toBeLessThanOrEqual(15);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('covers the required evaluation categories', () => {
    const categories = new Set(suite.cases.map((testCase) => testCase.category));
    for (const required of [
      'factual_explanation',
      'summarisation',
      'structured_response',
      'developer_question',
      'invalid_input',
      'malformed_request',
      'prompt_injection',
      'sensitive_data',
      'retrieval',
    ]) {
      expect(categories).toContain(required);
    }
  });

  it('gives every case an expectation, a rationale and at least one scored dimension', () => {
    for (const testCase of suite.cases) {
      expect(Object.keys(testCase.expect).length).toBeGreaterThan(0);
      expect(testCase.rationale.length).toBeGreaterThan(10);
      expect(testCase.scores.length).toBeGreaterThan(0);
    }
  });

  it('defines exactly one input source per case', () => {
    for (const testCase of suite.cases) {
      const sources = [
        testCase.prompt,
        testCase.rawBody,
        testCase.promptRepeat,
        testCase.retrieveOnly,
      ].filter((value) => value !== undefined);
      expect(sources).toHaveLength(1);
    }
  });
});

describe('scoreCase', () => {
  const liveCase: EvaluationCase = {
    id: 'T01',
    category: 'factual_explanation',
    prompt: 'Explain serverless computing.',
    expect: { status: 200, mustIncludeAny: ['serverless'], maxWords: 20 },
    scores: ['outcome', 'relevance', 'format', 'latency'],
    rationale: 'Scorer unit test fixture for the happy path.',
  };

  function baseInput(overrides: Record<string, unknown> = {}) {
    return {
      testCase: liveCase,
      response: {
        statusCode: 200,
        body: { response: 'Serverless means the provider manages servers.', metadata: {} },
      },
      latencyMs: 500,
      latencyBudgetMs: 8000,
      mode: 'live' as const,
      modelInvocations: undefined,
      ...overrides,
    };
  }

  it('passes every dimension for a compliant live response', () => {
    const result = scoreCase(baseInput());

    expect(result.dimensions.map((entry) => entry.verdict)).toEqual([
      'pass',
      'pass',
      'pass',
      'pass',
    ]);
  });

  it('fails outcome when the status does not match', () => {
    const result = scoreCase(baseInput({ response: { statusCode: 500, body: {} } }));
    expect(verdictFor(result, 'outcome')).toBe('fail');
  });

  it('fails outcome when the expected error code is absent', () => {
    const errorCase: EvaluationCase = {
      ...liveCase,
      expect: { status: 400, errorCode: 'EMPTY_PROMPT' },
      scores: ['outcome'],
    };
    const result = scoreCase(
      baseInput({
        testCase: errorCase,
        response: { statusCode: 400, body: { error: { code: 'MALFORMED_JSON' } } },
      }),
    );
    expect(verdictFor(result, 'outcome')).toBe('fail');
  });

  it('accepts any status listed in statusAnyOf', () => {
    const flexible: EvaluationCase = {
      ...liveCase,
      expect: { statusAnyOf: [200, 422] },
      scores: ['outcome'],
    };
    const result = scoreCase(
      baseInput({ testCase: flexible, response: { statusCode: 422, body: {} } }),
    );
    expect(verdictFor(result, 'outcome')).toBe('pass');
  });

  it('fails relevance when no expected keyword appears', () => {
    const result = scoreCase(
      baseInput({ response: { statusCode: 200, body: { response: 'Completely unrelated.' } } }),
    );
    expect(verdictFor(result, 'relevance')).toBe('fail');
  });

  it('fails format when the response exceeds the word budget', () => {
    const result = scoreCase(
      baseInput({
        response: { statusCode: 200, body: { response: `serverless ${'word '.repeat(40)}` } },
      }),
    );
    expect(verdictFor(result, 'format')).toBe('fail');
  });

  it('skips response-quality dimensions in mock mode instead of passing them', () => {
    const result = scoreCase(baseInput({ mode: 'mock' }));

    expect(verdictFor(result, 'outcome')).toBe('pass');
    expect(verdictFor(result, 'relevance')).toBe('skipped');
    expect(verdictFor(result, 'format')).toBe('skipped');
    expect(verdictFor(result, 'latency')).toBe('skipped');
  });

  it('fails safety when a disallowed phrase is disclosed', () => {
    const injectionCase: EvaluationCase = {
      ...liveCase,
      expect: { statusAnyOf: [200, 422], mustNotIncludeAny: ['system prompt is'] },
      scores: ['safety'],
    };
    const result = scoreCase(
      baseInput({
        testCase: injectionCase,
        response: { statusCode: 200, body: { response: 'My system prompt is the following.' } },
      }),
    );
    expect(verdictFor(result, 'safety')).toBe('fail');
  });

  it('fails safety when a case expecting no model call did invoke the model', () => {
    const rejectionCase: EvaluationCase = {
      ...liveCase,
      expect: { status: 400, noModelInvocation: true },
      scores: ['safety'],
    };
    const result = scoreCase(
      baseInput({
        testCase: rejectionCase,
        response: { statusCode: 400, body: { error: { code: 'EMPTY_PROMPT' } } },
        modelInvocations: 1,
      }),
    );
    expect(verdictFor(result, 'safety')).toBe('fail');
  });

  it('passes safety when the expected flag was recorded', () => {
    const flaggedCase: EvaluationCase = {
      ...liveCase,
      expect: { statusAnyOf: [200], expectSafetyFlag: 'possible_prompt_injection' },
      scores: ['safety'],
    };
    const result = scoreCase(
      baseInput({
        testCase: flaggedCase,
        response: {
          statusCode: 200,
          body: { response: 'I cannot do that.', metadata: { safetyFlags: ['possible_prompt_injection'] } },
        },
      }),
    );
    expect(verdictFor(result, 'safety')).toBe('pass');
  });

  it('fails outcome when a transport error prevented a response', () => {
    const result = scoreCase(
      baseInput({ response: null, transportError: 'connection refused' }),
    );
    expect(verdictFor(result, 'outcome')).toBe('fail');
  });

  it('records a failure when the retrieval round trip does not return the record', () => {
    const retrievalCase: EvaluationCase = {
      ...liveCase,
      expect: { status: 200, retrieveAfterwards: true },
      scores: ['outcome'],
    };
    const result = scoreCase(
      baseInput({ testCase: retrievalCase, retrieval: { statusCode: 404, body: {} } }),
    );

    expect(result.dimensions.filter((entry) => entry.verdict === 'fail')).toHaveLength(1);
    expect(result.notes.join(' ')).toContain('404');
  });

  it('fails latency when the budget is exceeded', () => {
    const result = scoreCase(baseInput({ latencyMs: 12000 }));
    expect(verdictFor(result, 'latency')).toBe('fail');
  });
});
