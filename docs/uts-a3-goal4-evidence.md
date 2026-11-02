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

## A1 Requirement Coverage Matrix (Zero-Cost Local Validation pass)

A second review pass, 2026-11-01, added a real local `amazon/dynamodb-local` Docker
container and 18 new tests (`test/local-integration.test.ts`,
`test/local-security.test.ts`) to close a specific gap the first pass left open: the
original 155 tests mock DynamoDB entirely, which proves application logic but not that
the actual DynamoDB wire calls are well-formed. Full detail:
`docs/local-validation-guide.md`, `docs/local-evaluation-report.md`.

**Correction note (2026-11-02, final P4 evidence review):** the table below was revised
in this third pass so that every status label is unambiguous *on its own*, without
requiring a reader to open the Limitation column to avoid overclaiming. In particular:
Lambda/API Gateway/IAM/CloudWatch rows now state in the status itself that synthesised
config or direct-handler-invocation is not the same as real cloud execution; Mock
Bedrock/Guardrail rows now state in the status itself that app-layer response-shape
handling is not proof of real model quality or real server-side filtering; Groundedness
is corrected from "NOT APPLICABLE / NOT IMPLEMENTED" to **NOT EVALUATED** (it *was* one
of the dimensions A1 planned to assess — the correct classification is that it was never
evaluated, not that it was inapplicable); and Architecture Documentation is corrected
from "NOT APPLICABLE" to **IMPLEMENTED**, since the documentation *is* the evidence for
that requirement, not something the requirement doesn't apply to. The "Automated Tests &
CI/CD" row is also corrected: see the new "CI Verification" section below for what was
actually found when this was checked properly (CI never ran on this branch at all, for a
more specific reason than "no push was made").

This table uses the five-value status vocabulary requested for this pass —
**IMPLEMENTED**, **LOCALLY VERIFIED** (proven against a real local engine — DynamoDB
Local), **MOCK VERIFIED** (proven against an in-memory stub only), **NOT VERIFIED**,
**NOT EVALUATED**, or **NOT APPLICABLE**. No AWS account, AWS credentials, or real
Bedrock call was used anywhere in this pass, consistent with every other document in
this repository.

| A1 Requirement | Implementation | Local Test | Evidence | Limitation |
|---|---|---|---|---|
| AWS Serverless Architecture | `lib/serverless-genai-stack.ts` | MOCK VERIFIED (synthesised template only — not executed in any cloud) | `cdk synth` (20 resource types), `test/infrastructure.test.ts` | No live deployment; serverless runtime behaviour (cold start, scaling) unobserved |
| AWS CDK (TypeScript) | `bin/app.ts`, `lib/*.ts` | LOCALLY VERIFIED (lint, typecheck, offline synth) | `npm run lint`/`typecheck` clean, `cdk synth` fully offline (dummy account/region) | `cdk bootstrap`/`cdk deploy` never run (out of scope for this review by instruction) |
| AWS Lambda | `src/handlers/generate.ts`, `get-request.ts` | LOCALLY VERIFIED (handler logic only — **not** a real Lambda runtime) | `test/local-integration.test.ts` — real end-to-end invocation with real DynamoDB persistence, not just a mock | The exported `handler` function is called directly in a local Node process. No real Lambda execution environment was ever used: no cold start, no AWS Lambda ARM64 sandbox, no enforced memory/timeout ceiling |
| Amazon API Gateway | `RestApi`, `AWS_IAM` auth, validator, throttle | MOCK VERIFIED (synthesised config only — API Gateway itself never executed, locally or in the cloud) | `test/infrastructure.test.ts` asserts the synthesised config | Every test in this repo invokes the Lambda handler directly. API Gateway's actual routing, SigV4 authorisation enforcement, request validation, and throttling have never been exercised in any form, local or cloud |
| Amazon DynamoDB | On-demand table, TTL, least-privilege grants | **LOCALLY VERIFIED (real local DynamoDB engine — NOT AWS Cloud DynamoDB)** | `test/local-integration.test.ts`, `test/local-security.test.ts` — real `PutCommand`/`GetCommand`, real `ConditionExpression` enforcement, real `ResourceNotFoundException` | `amazon/dynamodb-local` is AWS's own local engine, not AWS Cloud DynamoDB — it doesn't meter capacity, bill, or replicate, and isn't a byte-identical clone (no Global Tables/DAX). Real managed-service latency, availability, and billing behaviour remain NOT VERIFIED |
| Amazon Bedrock Integration | `src/shared/bedrock.ts` Converse API | MOCK VERIFIED (response-shape handling only — does **not** prove real model quality or availability) | `test/local-security.test.ts` (timeout shape), `test/generate-handler.test.ts` | NOT VERIFIED: no real Converse API call has ever been made in any review pass. Nothing here demonstrates what the real model would actually say, how fast, or whether the configured model id is even enabled in any account |
| Bedrock Guardrails / AI Safety | `CfnGuardrail` content + PII policy | MOCK VERIFIED (app-layer handling of a simulated blocked-response shape only — does **not** prove the real Bedrock Guardrail service would actually block or anonymise anything) | `test/local-security.test.ts` "simulates a guardrail block" | The real guardrail decision — would a given prompt actually be blocked, would `EMAIL`/`PHONE` actually be anonymised — is NOT VERIFIED and can only be proven by a live call against a deployed guardrail |
| IAM Least Privilege | `lib/bedrock-permissions.ts`, single-action grants | MOCK VERIFIED (synthesised policy document only — not a deployed, attached, or enforced role) | `test/infrastructure.test.ts` asserts the synthesised policy document | NOT VERIFIED that this is what's actually enforced by IAM at runtime — only that the CDK app, if deployed, would ask CloudFormation to create a role with this policy |
| LLM Evaluation — Relevance | `evaluation/scorer.ts` | NOT VERIFIED | `evaluate:mock` — 5 `skipped` | No real model output exists in any local mode to judge |
| LLM Evaluation — Groundedness | — | **NOT EVALUATED** | `evaluation/types.ts:3` — `Dimension` has no groundedness member | Groundedness *was* one of the dimensions A1 planned to assess for Goal 4 (relevance, groundedness, prompt injection, sensitive data, latency, failure behaviour). It was never evaluated because the harness never implemented a groundedness scorer — there is no `groundedness` member in the `Dimension` type, so no case has ever produced even a `skipped` verdict for it, let alone a `pass`. Separately, this architecture has no retrieval/context-grounding source (plain prompt→completion, not RAG), so even if a scorer existed, there is nothing obvious to check groundedness *against* without first adding a context/knowledge-base feature. Both facts are stated because the first one (never implemented) is a correctable gap and the second (no grounding source) is an architectural reason the gap was not trivial to close |
| LLM Evaluation — Prompt Injection | `evaluation/cases.json` C09/C10, `validation.ts` | **LOCALLY VERIFIED (app-layer heuristic flagging only)** | `test/local-security.test.ts` — flag confirmed on the real persisted DynamoDB item | Confirms this application's own regex-based flagging only; does NOT confirm the real model or the real guardrail actually declines the request — that half requires a live call |
| LLM Evaluation — Sensitive Data Handling | `evaluation/cases.json` C11, `validation.ts` | **LOCALLY VERIFIED (app-layer heuristic flagging only)** | `test/local-security.test.ts` | Same caveat as Prompt Injection |
| LLM Evaluation — Latency (real model) | `evaluation/scorer.ts scoreLatency` | NOT VERIFIED | `evaluate:mock` — 8 `skipped`; 0–7ms mock figures explicitly not presented as real | No real model call made |
| LLM Evaluation — Failure Behaviour | `evaluation/scorer.ts scoreOutcome` | **LOCALLY VERIFIED** | `test/local-security.test.ts` (whole file), `evaluate:mock` C05–C08/C13 | None of real significance — this dimension is exercised through real handler code and (for the DynamoDB-failure case) a real `ResourceNotFoundException`, and is well-covered without any deployment |
| LLM Evaluation — Guardrail Behaviour | `generate.ts` `ContentBlockedError` handling | MOCK VERIFIED (app-layer handling of a simulated response shape, now against real persistence — does **not** prove real guardrail-triggering behaviour) | `test/local-security.test.ts` | The actual guardrail-triggering decision remains NOT VERIFIED locally, same caveat as the Guardrails row above |
| CloudWatch / Observability | `logger.ts`, `CfnAlarm`/`Dashboard`, X-Ray `ACTIVE` | MOCK VERIFIED (synthesised configuration only — no real telemetry was ever produced) | `test/observability.test.ts`, `cdk synth` | NOT VERIFIED: no real CloudWatch log, metric, or trace exists anywhere as a result of this project — there is no local CloudWatch emulator in use, and none was attempted. Also note: this is AWS-native CloudWatch + X-Ray, not OpenTelemetry SDK instrumentation |
| Automated Tests & CI/CD | Jest, 10 suites (8 original + 2 new) | **LOCALLY VERIFIED (local test execution only — see "CI Verification" below for the actual GitHub Actions status)** | `npm test` — 173 tests, 171 passed, 2 documented skips, reproduced fresh on 2026-11-02 | CI (`.github/workflows/validate.yml`) has never run on this branch at all — not "skipped due to no database," but zero workflow runs exist for `feat/uts-a3-aws-evidence` in any form. See "CI Verification" below for the precise reason and evidence |
| Architecture Documentation & Portfolio Evidence | `docs/architecture.md`, `docs/security.md`, `docs/evaluation.md`, `docs/evidence-guide.md`, `docs/professional-reflection.md`, `docs/deployment-readiness.md`, `docs/local-validation-guide.md`, `docs/local-evaluation-report.md`, `docs/uts-a3-p4-portfolio.md`, this file, `README.md` | **IMPLEMENTED** (the documentation itself is the evidence for this requirement — "not applicable" would misstate that) | All files listed in the Implementation column exist in this repository right now and are individually readable/linkable | None — this is the most completely covered requirement in the project |

## CI Verification (checked precisely for this review, 2026-11-02)

**Finding: GitHub Actions has never executed on `feat/uts-a3-aws-evidence` — zero runs,
not a skip.** This is a more specific and more important finding than "CI skipped the
DynamoDB-dependent tests," so it is stated on its own:

1. `.github/workflows/validate.yml`'s trigger is:
   ```yaml
   on:
     push:
       branches: [main, 'feature/**']
     pull_request:
       branches: [main]
     workflow_dispatch:
   ```
2. This repository's working branch for all of this A3 evidence work is
   `feat/uts-a3-aws-evidence` — which matches **neither** `main` **nor** the glob
   `feature/**` (it is `feat/`, not `feature/`). No pull request targeting `main` was
   ever opened from this branch either, so the `pull_request` trigger never fired.
3. Verified directly, read-only, this review:
   ```
   $ gh run list --repo krischuang/43030-aws-serverless-genai --branch feat/uts-a3-aws-evidence --limit 10
   (no output — zero runs)
   $ gh pr list --repo krischuang/43030-aws-serverless-genai --head feat/uts-a3-aws-evidence --state all
   (no output — no PR ever opened)
   ```

**Consequence for every claim in this document and in `docs/local-evaluation-report.md`**:
every test result, lint/typecheck pass, `cdk synth` success, and mock-evaluation run
referenced anywhere in this review was executed **locally**, by direct command, not by
CI. "Automated Tests & CI/CD" above is therefore marked `LOCALLY VERIFIED`, not
`CI VERIFIED` — and must not be described as "CI integration tests passed," because CI
never ran them at all.

**What this does *not* affect**: `validate.yml` previously ran successfully against
`main` and `feature/serverless-genai-portfolio` before this branch existed (confirmed by
`gh run list` in the prior deployment-readiness review on 2026-11-01) — that history is
real and unaffected by this finding. It simply does not extend to anything committed on
`feat/uts-a3-aws-evidence`, including the new `test/local-*.test.ts` files, which have
never been run by any CI system, only by this review's own local `npm test`/
`npm run test:local` commands.

**If this branch is later merged into `main` or `feature/**`**, `validate.yml` would run
`npm test`, which would execute `test/local-integration.test.ts` and
`test/local-security.test.ts` on a GitHub-hosted runner with no DynamoDB Local container
provisioned (the workflow has no `services:` block for it). Those two files' own
reachability guard (`isDynamoDbLocalReachable()`) would then make them skip cleanly —
consistent with their designed behaviour verified locally in this review — but this
would still correctly be reported as **CI ran, local-DynamoDB tests skipped**, not
**CI integration tests passed**, unless a future change adds a `services: dynamodb-local:
...` block to the workflow to actually provision the container in CI.

## Reproducible Evidence Log (final P4 review, re-run fresh on 2026-11-02)

Every command below was re-executed during this review, not copied from a prior pass.
Commit reference for the state these numbers describe: `cfd60c7` (branch
`feat/uts-a3-aws-evidence`, pushed).

**Lint**
```
$ npm run lint
> eslint .
(no output — zero errors, zero warnings)
```

**Typecheck**
```
$ npm run typecheck
> tsc --noEmit
(no output — zero errors)
```

**Full test suite, DynamoDB Local unreachable (container not yet started)**
```
$ npm test
Test Suites: 2 skipped, 8 passed, 8 of 10 total
Tests:       20 skipped, 155 passed, 175 total
```

**Full test suite, DynamoDB Local reachable (`npm run dynamodb:local:up` first)**
```
$ npm test
Test Suites: 10 passed, 10 total
Tests:       2 skipped, 171 passed, 173 total
```
The 2 skips here are the two deliberate documentation-only `it.skip` entries in
`test/local-security.test.ts` (Unauthorized Request Handling; real Guardrail
filter/anonymisation behaviour) — not failures, and not affected by DynamoDB Local's
availability.

**Local integration + security suite in isolation**
```
$ npx jest --runInBand test/local-integration.test.ts test/local-security.test.ts
Test Suites: 2 passed, 2 total
Tests:       2 skipped, 16 passed, 18 total
```

**DynamoDB Local — what was actually verified**: real `CreateTableCommand`,
`PutCommand`, `GetCommand`, `DeleteTableCommand` against `amazon/dynamodb-local:latest`
running in Docker (`docker run ... -jar DynamoDBLocal.jar -sharedDb -inMemory`); real
`ConditionExpression` rejection on a duplicate `requestId` write; real
`ResourceNotFoundException` when addressing a table that was never created. None of this
touches AWS Cloud DynamoDB.

**CDK synth (fully offline)**
```
$ CDK_DEFAULT_ACCOUNT=000000000000 CDK_DEFAULT_REGION=ap-southeast-2 npx cdk synth --quiet
(exit code 0; 26 feature flags not configured — informational only)
```
Resource inventory extracted from the synthesised template (unchanged from the prior
review, re-verified): 2 `AWS::Lambda::Function`, 1 `AWS::DynamoDB::Table`, 1
`AWS::ApiGateway::RestApi` (+2 methods, 1 validator, 1 model), 1 `AWS::Bedrock::Guardrail`
+ 1 `GuardrailVersion`, 2 `AWS::CloudWatch::Alarm`, 1 `AWS::CloudWatch::Dashboard`, 3
`AWS::IAM::Role`, 2 `AWS::IAM::Policy`, 1 `AWS::SNS::Topic` (+1 `TopicPolicy`), 3
`AWS::Logs::LogGroup`, 4 `AWS::Lambda::Permission`, 1 `AWS::ApiGateway::Account`/
`Deployment`/`Stage` each, 1 `AWS::CDK::Metadata`.

**Mock evaluation**
```
$ npm run evaluate:mock
Cases with no failing dimension: 13/13
Dimension checks: 20 pass, 0 fail, 16 skipped
```
Full per-case breakdown: `docs/local-evaluation-report.md`.

**Dependency audit (production dependencies only)**
```
$ npm audit --omit=dev
2 moderate severity vulnerabilities
```
Both are `minimatch`, bundled inside `aws-cdk-lib` itself with no upstream fix published
yet — unchanged from the prior review, confirmed CDK/CLI-tooling-only (not bundled into
deployed Lambda code).

**Git commit references** (branch `feat/uts-a3-aws-evidence`, all pushed):

| Commit | Subject |
|---|---|
| `187541a` | test: strengthen serverless GenAI validation |
| `19f225f` | docs: add deployment readiness and A3 evidence mapping |
| `8e87911` | test: add local DynamoDB integration and security test suite |
| `cfd60c7` | docs: add zero-cost local validation guide and evaluation report |

## Evidence Matrix (original pass, 2026-11-01 — deployment-readiness review)

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
