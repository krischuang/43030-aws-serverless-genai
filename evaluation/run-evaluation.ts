/**
 * Evaluation runner.
 *
 * Usage:
 *   npm run evaluate:mock
 *   npm run evaluate -- --mode live --api <api-base-url> [--region ap-southeast-2]
 *
 * Writes a JSON result set and a Markdown report under evidence/ (which is
 * git-ignored because live reports contain the deployed API host name).
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { scoreCase } from './scorer';
import { LiveTransport, MockTransport } from './transports';
import type {
  CaseResult,
  CaseSuite,
  EvaluationCase,
  EvaluationReport,
  EvaluationTransport,
  Verdict,
} from './types';

interface Options {
  mode: 'mock' | 'live';
  apiBaseUrl?: string;
  region: string;
  modelId: string;
  outputDir: string;
}

function parseOptions(argv: string[]): Options {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) {
      flags.set(argv[i].slice(2), argv[i + 1] ?? 'true');
      i += 1;
    }
  }

  const mode = (flags.get('mode') ?? process.env.EVALUATION_MODE ?? 'mock') as 'mock' | 'live';
  if (mode !== 'mock' && mode !== 'live') {
    throw new Error(`Unsupported --mode "${mode}". Use "mock" or "live".`);
  }

  const apiBaseUrl = flags.get('api') ?? process.env.API_BASE_URL;
  if (mode === 'live' && (apiBaseUrl === undefined || apiBaseUrl === '')) {
    throw new Error('Live mode requires --api <api-base-url> or API_BASE_URL.');
  }

  return {
    mode,
    apiBaseUrl,
    region: flags.get('region') ?? process.env.AWS_REGION ?? 'ap-southeast-2',
    modelId: flags.get('model') ?? process.env.BEDROCK_MODEL_ID ?? 'apac.amazon.nova-micro-v1:0',
    outputDir: flags.get('out') ?? 'evidence',
  };
}

function buildBody(testCase: EvaluationCase): string | undefined {
  if (testCase.rawBody !== undefined) {
    return testCase.rawBody;
  }
  if (testCase.promptRepeat !== undefined) {
    return JSON.stringify({
      prompt: testCase.promptRepeat.unit.repeat(testCase.promptRepeat.times),
    });
  }
  if (testCase.prompt !== undefined) {
    return JSON.stringify({ prompt: testCase.prompt });
  }
  return undefined;
}

async function runCase(
  testCase: EvaluationCase,
  transport: EvaluationTransport,
  latencyBudgetMs: number,
): Promise<CaseResult> {
  if (transport instanceof MockTransport) {
    transport.resetCounters();
  }

  const startedAt = Date.now();
  let response = null;
  let transportError: string | undefined;
  let retrieval = null;

  try {
    if (testCase.retrieveOnly !== undefined) {
      response = await transport.retrieve(testCase.retrieveOnly);
    } else {
      const body = buildBody(testCase);
      if (body === undefined) {
        throw new Error('case declares neither a prompt, a rawBody nor retrieveOnly');
      }
      response = await transport.generate(body);

      if (testCase.expect.retrieveAfterwards === true && response.statusCode === 200) {
        const requestId = (response.body as { requestId?: string }).requestId;
        retrieval = requestId === undefined ? null : await transport.retrieve(requestId);
      }
    }
  } catch (error) {
    transportError = error instanceof Error ? error.message : String(error);
  }

  const latencyMs = Date.now() - startedAt;

  return scoreCase({
    testCase,
    response,
    latencyMs,
    latencyBudgetMs,
    mode: transport.mode,
    modelInvocations: transport.modelInvocations?.(),
    ...(transportError === undefined ? {} : { transportError }),
    retrieval,
  });
}

function summarise(
  results: CaseResult[],
  options: Options,
  suite: CaseSuite,
  startedAt: string,
): EvaluationReport {
  const byVerdict: Record<Verdict, number> = { pass: 0, fail: 0, skipped: 0 };
  const byDimension: Record<string, { pass: number; fail: number; skipped: number }> = {};

  for (const result of results) {
    for (const dimension of result.dimensions) {
      byVerdict[dimension.verdict] += 1;
      byDimension[dimension.dimension] ??= { pass: 0, fail: 0, skipped: 0 };
      byDimension[dimension.dimension][dimension.verdict] += 1;
    }
  }

  const latencies = results.map((result) => result.latencyMs).sort((a, b) => a - b);
  const median =
    latencies.length === 0
      ? 0
      : latencies.length % 2 === 1
        ? latencies[(latencies.length - 1) / 2]
        : Math.round((latencies[latencies.length / 2 - 1] + latencies[latencies.length / 2]) / 2);

  return {
    mode: options.mode,
    startedAt,
    suiteVersion: suite.version,
    modelId: options.mode === 'mock' ? `${options.modelId} (stubbed)` : options.modelId,
    caseCount: results.length,
    results,
    totals: {
      byVerdict,
      byDimension,
      casesFullyPassed: results.filter((result) =>
        result.dimensions.every((dimension) => dimension.verdict !== 'fail'),
      ).length,
      latencyMs: {
        min: latencies[0] ?? 0,
        median,
        max: latencies[latencies.length - 1] ?? 0,
      },
    },
  };
}

function renderMarkdown(report: EvaluationReport, suite: CaseSuite): string {
  const icon = (verdict: Verdict): string =>
    verdict === 'pass' ? 'pass' : verdict === 'fail' ? 'FAIL' : 'skip';

  const lines: string[] = [
    `# Evaluation report (${report.mode} mode)`,
    '',
    `- Suite version: ${report.suiteVersion}`,
    `- Run started: ${report.startedAt}`,
    `- Model: ${report.modelId}`,
    `- Cases executed: ${report.caseCount}`,
    `- Cases with no failing dimension: ${report.totals.casesFullyPassed}/${report.caseCount}`,
    `- Dimension checks: ${report.totals.byVerdict.pass} pass, ${report.totals.byVerdict.fail} fail, ${report.totals.byVerdict.skipped} skipped`,
    `- Latency (ms): min ${report.totals.latencyMs.min}, median ${report.totals.latencyMs.median}, max ${report.totals.latencyMs.max}`,
    '',
  ];

  if (report.mode === 'mock') {
    lines.push(
      '> Mock mode stubs the Bedrock and DynamoDB clients. It verifies routing, validation,',
      '> safety flagging, persistence and error handling. Response-quality and latency',
      '> dimensions are reported as skipped because no model was invoked.',
      '',
    );
  }

  lines.push('## Dimension totals', '', '| Dimension | Pass | Fail | Skipped |', '| --- | --- | --- | --- |');
  for (const [dimension, totals] of Object.entries(report.totals.byDimension)) {
    lines.push(`| ${dimension} | ${totals.pass} | ${totals.fail} | ${totals.skipped} |`);
  }

  lines.push('', '## Case results', '', '| Case | Category | Status | Latency (ms) | Outcome | Relevance | Format | Safety | Latency |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const result of report.results) {
    const verdictFor = (dimension: string): string => {
      const match = result.dimensions.find((entry) => entry.dimension === dimension);
      return match === undefined ? '-' : icon(match.verdict);
    };
    lines.push(
      `| ${result.id} | ${result.category} | ${result.statusCode ?? 'n/a'} | ${result.latencyMs} | ${verdictFor('outcome')} | ${verdictFor('relevance')} | ${verdictFor('format')} | ${verdictFor('safety')} | ${verdictFor('latency')} |`,
    );
  }

  lines.push('', '## Detail', '');
  for (const result of report.results) {
    const testCase = suite.cases.find((entry) => entry.id === result.id);
    lines.push(`### ${result.id}`, '', `_${testCase?.rationale ?? ''}_`, '');
    for (const dimension of result.dimensions) {
      lines.push(`- **${dimension.dimension}** — ${icon(dimension.verdict)}: ${dimension.detail}`);
    }
    for (const note of result.notes) {
      lines.push(`- note: ${note}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const suite = JSON.parse(
    readFileSync(join(__dirname, 'cases.json'), 'utf8'),
  ) as CaseSuite;

  const transport: EvaluationTransport =
    options.mode === 'mock'
      ? new MockTransport(options.modelId)
      : new LiveTransport(options.apiBaseUrl as string, options.region);

  const startedAt = new Date().toISOString();
  console.log(`Running ${suite.cases.length} evaluation cases in ${options.mode} mode`);

  const results: CaseResult[] = [];
  for (const testCase of suite.cases) {
    const result = await runCase(testCase, transport, suite.defaults.latencyBudgetMs);
    results.push(result);
    const failures = result.dimensions.filter((dimension) => dimension.verdict === 'fail');
    console.log(
      `  ${failures.length === 0 ? 'OK  ' : 'FAIL'} ${result.id} (status ${result.statusCode ?? 'n/a'}, ${result.latencyMs} ms)`,
    );
    for (const failure of failures) {
      console.log(`         ${failure.dimension}: ${failure.detail}`);
    }
  }

  const report = summarise(results, options, suite, startedAt);

  mkdirSync(options.outputDir, { recursive: true });
  const jsonPath = join(options.outputDir, `evaluation-${options.mode}.json`);
  const markdownPath = join(options.outputDir, `evaluation-${options.mode}.md`);
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(markdownPath, `${renderMarkdown(report, suite)}\n`);

  console.log('');
  console.log(
    `Cases with no failing dimension: ${report.totals.casesFullyPassed}/${report.caseCount}`,
  );
  console.log(
    `Dimension checks: ${report.totals.byVerdict.pass} pass, ${report.totals.byVerdict.fail} fail, ${report.totals.byVerdict.skipped} skipped`,
  );
  console.log(`Reports written to ${jsonPath} and ${markdownPath}`);

  if (report.totals.byVerdict.fail > 0) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
