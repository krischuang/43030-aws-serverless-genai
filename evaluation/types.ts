/** Shared types for the evaluation harness. */

export type Dimension = 'outcome' | 'relevance' | 'format' | 'safety' | 'latency';

export type Verdict = 'pass' | 'fail' | 'skipped';

export interface CaseExpectation {
  status?: number;
  statusAnyOf?: number[];
  errorCode?: string;
  mustIncludeAny?: string[];
  mustNotIncludeAny?: string[];
  mustMatch?: string;
  mustNotMatch?: string;
  maxWords?: number;
  noModelInvocation?: boolean;
  expectSafetyFlag?: string;
  retrieveAfterwards?: boolean;
}

export interface EvaluationCase {
  id: string;
  category: string;
  prompt?: string;
  rawBody?: string;
  promptRepeat?: { unit: string; times: number };
  retrieveOnly?: string;
  expect: CaseExpectation;
  scores: Dimension[];
  rationale: string;
}

export interface CaseSuite {
  version: number;
  description: string;
  dimensions: Record<Dimension, string>;
  defaults: { latencyBudgetMs: number };
  cases: EvaluationCase[];
}

export interface ApiResponse {
  statusCode: number;
  body: unknown;
}

/** Minimal transport contract so mock and live modes share the scorer. */
export interface EvaluationTransport {
  readonly mode: 'mock' | 'live';
  generate(body: string): Promise<ApiResponse>;
  retrieve(requestId: string): Promise<ApiResponse>;
  /** Number of model invocations observed, where the transport can see them. */
  modelInvocations?(): number;
}

export interface DimensionResult {
  dimension: Dimension;
  verdict: Verdict;
  detail: string;
}

export interface CaseResult {
  id: string;
  category: string;
  statusCode: number | null;
  latencyMs: number;
  dimensions: DimensionResult[];
  notes: string[];
}

export interface EvaluationReport {
  mode: 'mock' | 'live';
  startedAt: string;
  suiteVersion: number;
  modelId: string;
  caseCount: number;
  results: CaseResult[];
  totals: {
    byVerdict: Record<Verdict, number>;
    byDimension: Record<string, { pass: number; fail: number; skipped: number }>;
    casesFullyPassed: number;
    latencyMs: { min: number; median: number; max: number };
  };
}
