# UTS 43030 A3 — Goal 4 Evidence Matrix

A1 Goal 4: *"Build and evaluate a secure AWS serverless generative AI application."*
This matrix states, per requirement, what is **Implemented in Code**, **Unit Tested**,
**Infrastructure Tested**, **Mock Evaluated**, **Deployed**, **Live Verified**, or
**Not Verified** — and nothing is marked `Deployed` or `Live Verified` unless this review
actually observed that evidence. See `docs/deployment-readiness.md` for why no deployment
has happened yet, and `docs/evidence-guide.md` for what to capture once it does.

All checks below (lint, typecheck, 155-test suite, `cdk synth`, mock evaluation, `npm audit`,
GitHub Actions run history) were run or inspected during this review on 2026-11-01.
No AWS API calls were made and no AWS resources were created or modified.

## Evidence Matrix

| A1 Requirement | Implementation | Test Evidence | Deployment Status | Remaining Gap |
|---|---|---|---|---|
| AWS Serverless Architecture | `lib/serverless-genai-stack.ts` — API Gateway + Lambda + DynamoDB + Bedrock, zero servers/containers | Infrastructure Tested — `cdk synth` succeeded this review, producing a real template (20 resource types, see `docs/deployment-readiness.md` §7) | **Not Verified** | Live deployment |
| AWS CDK (TypeScript) | `bin/app.ts`, `lib/*.ts`, `cdk.json` context-driven config | Unit Tested (`npm run typecheck`, `npm run lint` both clean this review) + Infrastructure Tested (`cdk synth`) | **Not Verified** | `cdk bootstrap` / `cdk deploy` never run (blocked — see below) |
| AWS Lambda | `src/handlers/generate.ts`, `src/handlers/get-request.ts` — Node.js 22, ARM64 | Unit Tested (`test/generate-handler.test.ts`, `test/get-request-handler.test.ts`, part of the 155/155 passing this review) + Infrastructure Tested (synth confirms 2 `AWS::Lambda::Function`) | **Not Verified** | Live invocation (E6) |
| Amazon API Gateway | `RestApi` with `AWS_IAM` auth, request validator, model, stage throttling 5/10 | Infrastructure Tested (`test/infrastructure.test.ts` asserts auth type, validator, throttle config) | **Not Verified** | Live 403-unsigned-rejection proof, live config screenshot (E5) |
| Amazon DynamoDB | On-demand table, TTL, SSE, least-privilege single-action grants (`PutItem`/`GetItem`) | Infrastructure Tested (`test/infrastructure.test.ts:132-135`, part of 155/155 this review) | **Not Verified** | Live table + item screenshot (E7) |
| Amazon Bedrock Integration | `src/shared/bedrock.ts` — Converse API, mock/live transport split | Unit Tested (`test/bedrock.test.ts`) + **Mock Evaluated** (`npm run evaluate:mock` this review: 13/13 cases ran) | **Not Verified** — `"mode": "live"` has never been produced | Bedrock model access enablement on the target account is unconfirmed (console-only check, not inspectable from this repo); live call (E8) |
| Bedrock Guardrails / AI Safety | CDK creates `AWS::Bedrock::Guardrail` + `GuardrailVersion` directly (confirmed by `cdk synth` this review); `bedrock:ApplyGuardrail` scoped to one guardrail ARN | Infrastructure Tested (resource + IAM scope confirmed by synth and `test/infrastructure.test.ts`) — **the actual content-blocking behaviour is not exercised even in mock mode**: `evaluation/transports.ts`'s `MockTransport` stubs `ConverseCommand` to always succeed, so the guardrail-intervention path (HTTP 422) is never triggered by any test or mock evaluation run | **Not Verified** | This is the single largest evaluation gap in the project: guardrail *behaviour* (not just its existence) can only be proven by a live call that actually trips it |
| IAM Least Privilege | `lib/bedrock-permissions.ts`, per-function single-action DynamoDB/Bedrock grants, no wildcards | Infrastructure Tested (`test/infrastructure.test.ts` — e.g. `'never grants a DynamoDB wildcard action'`, part of 155/155 this review) | **Not Verified** | Live IAM role console screenshot (E15) confirms deployed-as-written, not just synthesised-as-written |
| **LLM Evaluation — Relevance** | `evaluation/scorer.ts` `scoreRelevance` | **Mock Evaluated: skipped** (5/5 relevant cases — mock mode has no real model output to judge; this is correctly reported as `skipped`, not faked as `pass`) | **Not Verified** | Needs a live deployment to produce any real verdict |
| **LLM Evaluation — Groundedness** | **Not Implemented** | N/A | N/A | The evaluation harness's `Dimension` type (`evaluation/types.ts:3`) has exactly five members — `outcome`, `relevance`, `format`, `safety`, `latency` — and none of them is groundedness. This architecture has no retrieval/context-grounding source (it is a plain prompt→completion service, not RAG), so there is nothing to check a response's groundedness *against*. Recommendation: either scope groundedness as N/A for this non-RAG design in the written report, or treat it as future work contingent on adding a knowledge-base/context feature — adding a cosmetic groundedness check with no real grounding source to measure against was deliberately not done in this review, to avoid manufacturing evidence |
| **LLM Evaluation — Prompt Injection** | `evaluation/cases.json` C09/C10, `src/shared/validation.ts` heuristic flagging | **Mock Evaluated: partial** — the `safety` dimension correctly scores `pass` for "flagged `possible_prompt_injection`" in mock mode, but the non-disclosure check (`mustNotIncludeAny`) is explicitly `skipped` because it needs real model output | **Not Verified** | Live call needed to confirm the model/guardrail actually declines rather than just that the app-layer flag fired |
| **LLM Evaluation — Sensitive Data Handling** | `evaluation/cases.json` C11 | Same pattern as Prompt Injection — safety flag confirmed in mock, content-leakage check skipped | **Not Verified** | Live call |
| **LLM Evaluation — Latency** | `evaluation/scorer.ts` `scoreLatency`, 8000ms budget | **Mock Evaluated: skipped** (8/8 latency checks — "mock mode latency is not representative," correctly not reported as a false pass) | **Not Verified** | Live call |
| **LLM Evaluation — Failure Behaviour** | `evaluation/scorer.ts` `scoreOutcome`, cases C05–C08, C13 | **Mock Evaluated — genuinely, not superficially**: `MockTransport` runs the real `generateHandler`/`getRequestHandler` code in-process (only the Bedrock/DynamoDB SDK clients are stubbed), so validation/error-handling logic is exercised for real. 13/13 outcome checks passed this review | This dimension does **not** require live deployment to be meaningfully verified — it already is | None — this is the strongest-verified evaluation dimension |
| **LLM Evaluation — Guardrail Behaviour** | See "Bedrock Guardrails" row above | **Not evaluated in any mode** — mock mode's stubbed Bedrock client cannot trigger a guardrail block, so this has literally never been exercised, mock or live | **Not Verified** | Same gap as the Guardrails row — requires a live call specifically crafted to trip the guardrail |
| CloudWatch Observability | Structured JSON logger (`src/shared/logger.ts`), 2 `AWS::CloudWatch::Alarm`, 1 `AWS::CloudWatch::Dashboard`, X-Ray tracing on both Lambdas | Infrastructure Tested (`test/observability.test.ts`, confirmed by synth: 2 alarms, 1 dashboard, 3 log groups) | **Not Verified** | No live logs/metrics/traces exist. Note on terminology: this is **AWS-native CloudWatch + X-Ray**, not OpenTelemetry SDK instrumentation — if the A1 goal specifically expects OTel, that is a real gap, not just a deployment gap. `README.md` §12/E10 already self-discloses that X-Ray traces don't cover Bedrock/DynamoDB subsegments because the AWS SDK itself isn't X-Ray-instrumented |
| Automated Tests & CI/CD | Jest, 8 suites | **Unit Tested + Infrastructure Tested, verified this review**: `npm test` → 155/155 passing (exactly matches the README/evidence-guide claim). `.github/workflows/validate.yml` runs on push/PR; `gh run list` (read-only, this review) confirms real green runs on `main` and `feature/serverless-genai-portfolio`. Four recent Dependabot dev-tooling-bump PRs (#12 open, #10/#9/#6 closed) failed CI on a peer-dependency conflict introduced by the bumped packages themselves (`typescript-eslint`/`ts-jest`/`typescript` version mismatch) — **none of these were merged**, so `main`'s verified-passing state is unaffected | CI configuration + history confirmed; deployment pipeline (`.github/workflows/deploy.yml`, OIDC, `workflow_dispatch`-only) is configured but has never run (0 `deploy` workflow runs in history) | `deploy.yml` has never executed — consistent with the project never having been deployed |
| Architecture Documentation & Portfolio Evidence | `docs/architecture.md`, `docs/security.md`, `docs/evaluation.md`, `docs/evidence-guide.md`, `docs/professional-reflection.md`, `README.md` | N/A (documentation, not code) | N/A | None — this is the strongest-covered requirement in the project; `docs/evidence-guide.md` in particular already distinguishes no-deployment-needed vs requires-deployment evidence per item, which this matrix extends rather than duplicates |

## Dependency security (production-relevant only)

`npm audit --omit=dev` found 1 high-severity finding (`brace-expansion`, transitive via
`aws-cdk-lib`) — fixed in this review via `npm audit fix` (lockfile-only, no breaking
change). 1 moderate finding remains (`minimatch`, bundled inside `aws-cdk-lib` itself, no
upstream fix available yet) — confirmed to be CDK/CLI tooling only, never bundled into
deployed Lambda code (`grep -rl aws-cdk-lib src/` returns nothing). Consistent with
`docs/security.md` §1 T12's own prior disclosure of this category of residual risk.

## Summary

**Strongly evidenced without any deployment**: CDK/IaC correctness, Lambda/API
Gateway/DynamoDB/Bedrock/Guardrails resource definitions and their IAM scoping, automated
testing, CI, failure-behaviour evaluation, and architecture documentation.

**Genuinely blocked on deployment, not on missing code**: every "live" evidence item
(E4–E10, E13's live half, E15's deployed half) — because the stack has never been
deployed (`docs/deployment-readiness.md` §6 diagnoses why: a rejected, not merely
unconfigured, local AWS credential).

**A real, code-level gap independent of deployment**: the Groundedness evaluation
dimension does not exist, and Guardrail *behaviour* (as opposed to guardrail *existence*)
has never been exercised in any mode, mock or live, because the mock transport's stubbed
Bedrock client cannot produce a blocked response.
