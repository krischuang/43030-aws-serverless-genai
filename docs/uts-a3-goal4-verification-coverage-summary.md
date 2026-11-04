# UTS 43030 A3 — Goal 4 Verification Coverage Summary

**Purpose**: a single, compact reference for A3 P4 that maps A1 Goal 4 onto what was
actually implemented and verified, how, with what result, and what remains open. It
consolidates (does not replace) the detailed evidence already in
`docs/uts-a3-goal4-evidence.md` (full per-requirement matrix) and
`docs/uts-a3-p4-portfolio.md` (narrative portfolio document) — those remain the
authoritative detailed sources; this document is the index/summary layer requested for
A3 P4.

**Re-verified fresh, zero AWS cost, 2026-11-03** (the numbers below were re-run in this
session, not copied from the 2026-11-02 documents, and matched them exactly):

```
npm run lint        → clean
npm run typecheck   → clean
npm test (DynamoDB Local reachable) → Test Suites: 10 passed, 10 total
                                       Tests: 2 skipped, 171 passed, 173 total
cdk synth (dummy account/region)    → exit 0, 26 feature flags informational only
npm run evaluate:mock               → 13/13 cases, 20 pass / 0 fail / 16 skipped
npm audit --omit=dev                → 2 moderate (minimatch, bundled in aws-cdk-lib,
                                       no upstream fix; CDK/CLI tooling only, not in
                                       deployed Lambda code)
gh run list (feat/uts-a3-aws-evidence) → #41406298153 success, #41407031161 success
                                          (both confirmed live on GitHub, not reconstructed)
```

No AWS account, AWS credential, or billable API call was used to produce any number in
this document.

---

## 1. A1 Original Goal

> Goal 4: *"Build and evaluate a secure AWS serverless generative AI application."*

Planned components (from A1): AWS serverless architecture, AWS CDK (TypeScript), AWS
Lambda, Amazon API Gateway, Amazon DynamoDB, Amazon Bedrock integration, Bedrock
Guardrails/AI safety, IAM least privilege, an LLM evaluation harness (relevance,
groundedness, prompt injection, sensitive data, latency, failure behaviour), CloudWatch
observability, automated tests/CI, and architecture documentation.

## 2. Implemented Components

All twelve planned areas have real, reviewable source in this repository — nothing in
this list is a stub or a placeholder:

| Component | Source |
|---|---|
| Infrastructure as code | `lib/serverless-genai-stack.ts`, `lib/bedrock-permissions.ts`, `lib/stack-config.ts`, `bin/app.ts` |
| Lambda handlers | `src/handlers/generate.ts`, `src/handlers/get-request.ts` |
| Data layer | `src/shared/repository.ts` (DynamoDB, data-minimised record shape) |
| Bedrock integration | `src/shared/bedrock.ts` (Converse API, mock/live transport split) |
| Guardrail | `CfnGuardrail` + `CfnGuardrailVersion` in `lib/serverless-genai-stack.ts` |
| IAM | `lib/bedrock-permissions.ts` — single-action grants, scoped ARNs, no wildcards |
| Evaluation harness | `evaluation/scorer.ts`, `evaluation/transports.ts`, `evaluation/types.ts`, `evaluation/cases.json`, `evaluation/run-evaluation.ts` |
| Observability | `src/shared/logger.ts`, `CfnAlarm` × 2, `CfnDashboard`, X-Ray `ACTIVE` on both Lambdas |
| CI | `.github/workflows/validate.yml` |
| Documentation | `docs/architecture.md`, `docs/security.md`, `docs/evaluation.md`, plus the evidence documents listed in §5 |

## 3. Verification Method

Four independent layers, each proving something different and explicitly not claiming
to prove what it can't:

1. **Unit / infrastructure tests (mocked)** — `test/*.test.ts` (pre-existing, 155 of the
   173 total). Proves application logic and synthesised CloudFormation shape against
   controlled inputs.
2. **Local integration tests (real local engine)** — `test/local-integration.test.ts`,
   `test/local-security.test.ts` (18 tests) against `amazon/dynamodb-local` in Docker.
   Proves the actual DynamoDB wire protocol calls (`PutCommand`, `GetCommand`,
   `ConditionExpression`, `ResourceNotFoundException`) are well-formed against a real
   DynamoDB-API-compatible engine — not just an obedient mock.
3. **Offline infrastructure synthesis** — `cdk synth` with a dummy account/region.
   Proves the CDK app produces valid CloudFormation; proves nothing about deployed
   behaviour.
4. **CI reproduction** — GitHub Actions (`validate.yml`) re-running all of the above on
   a neutral, GitHub-hosted runner, with a dedicated step that hard-fails if the
   DynamoDB Local tests silently skip instead of genuinely running. Closes the
   "works on my machine" gap without touching AWS.

## 4. Actual Test Results (re-run 2026-11-03)

| Check | Result |
|---|---|
| Lint / typecheck | Clean, 0 errors |
| `npm test` (full suite, DynamoDB Local up) | **173 tests: 171 passed, 2 skipped** (2 skips are deliberate documentation-only `it.skip` entries, not failures) |
| `npm test` (DynamoDB Local down) | 175 total, 155 passed, 20 skipped — confirms the local-integration suite correctly self-skips rather than failing or silently passing when its dependency is absent |
| Local DynamoDB suite in isolation | 18 tests: 16 passed, 2 skipped |
| `cdk synth` | Succeeds, 20 CloudFormation resource types, 0 AWS calls |
| `npm run evaluate:mock` | 13/13 cases with no failing dimension; 20 dimension checks pass, 0 fail, 16 skip (skips are the dimensions that genuinely cannot be judged without a real model call) |
| `npm audit --omit=dev` | 2 moderate (CDK-bundled `minimatch`, no upstream fix, not in deployed code) |
| GitHub Actions `#41406298153` (commit `5d92368`) | `success` — 173 tests/171 passed/2 skipped reproduced on a GitHub-hosted runner, including a genuine (non-skipped) DynamoDB Local run |
| GitHub Actions `#41407031161` (commit `850f084`) | `success` — same result, confirmed on a follow-up documentation commit |

## 5. Evidence Links

- Branch: `https://github.com/krischuang/43030-aws-serverless-genai/tree/feat/uts-a3-aws-evidence`
- CI runs: [`#41406298153`](https://github.com/krischuang/43030-aws-serverless-genai/actions/runs/41406298153), [`#41407031161`](https://github.com/krischuang/43030-aws-serverless-genai/actions/runs/41407031161)
- Full per-requirement matrix: `docs/uts-a3-goal4-evidence.md`
- Narrative portfolio document: `docs/uts-a3-p4-portfolio.md`
- Deployment blocker diagnosis: `docs/deployment-readiness.md`
- Evaluation detail: `docs/local-evaluation-report.md`, `evidence/evaluation-mock.md`, `evidence/evaluation-mock.json`
- Reproduction guide: `docs/local-validation-guide.md`
- Test source: `test/local-integration.test.ts`, `test/local-security.test.ts`, `test/infrastructure.test.ts`

## 6. Remaining Limitations

Stated as plainly here as everywhere else in this repository — these are **not**
resolved by anything in this review:

- **No real AWS deployment has ever succeeded.** The local AWS credential returns
  `InvalidClientTokenId` — rejected, not merely absent (`docs/deployment-readiness.md`).
- **Amazon Bedrock**: no real Converse API call has ever been made. Model quality,
  latency, and availability are unverified.
- **Bedrock Guardrails**: the real guardrail's block/anonymise decision has never been
  observed; only the application's handling of a *simulated* block response is tested.
- **Amazon API Gateway**: routing, SigV4 authorisation enforcement, request validation,
  and throttling have never been exercised in any form — every test invokes the Lambda
  handler directly, bypassing API Gateway entirely.
- **AWS Lambda runtime**: handler logic is verified; cold start, the ARM64 execution
  sandbox, and memory/timeout enforcement are not.
- **CloudWatch / X-Ray**: alarms, dashboard, and tracing are defined in CDK and
  synthesised correctly; no real metric, log, or trace has ever been produced.
- **IAM**: the least-privilege policy document is asserted against the *synthesised*
  CloudFormation, not against a deployed, attached, enforced role.
- **Evaluation — Relevance, Latency**: `NOT VERIFIED` — no real model output exists in
  any local mode to score.
- **Evaluation — Groundedness**: `NOT EVALUATED` — the harness has no groundedness
  scorer at all (`evaluation/types.ts` has no `groundedness` dimension member), and the
  architecture has no retrieval/grounding source to check against even if one existed.
- **DynamoDB Local ≠ AWS Cloud DynamoDB.** It is AWS's own local engine, not a
  byte-identical clone — no capacity metering, billing, replication, Global Tables, or
  DAX. Real managed-service latency and availability remain unverified.

## 7. Professional Engineering Decisions

**Why DynamoDB Local, CDK Assertions, Mock Bedrock, and GitHub Actions — and not a real
AWS account — given the zero-cloud-cost constraint:**

- **DynamoDB Local** was chosen because it is the one AWS serverless dependency with an
  officially supported, byte-compatible local engine (`amazon/dynamodb-local`). Using it
  closes a real gap that pure mocking leaves open — whether the actual DynamoDB wire
  calls (conditional writes, duplicate-key rejection, `ResourceNotFoundException`) are
  well-formed — at zero cost and with no AWS credential at all. This was a deliberate
  upgrade over the original mocked-only test suite, added specifically because "the mock
  always agrees with itself" is not evidence of anything beyond the mock's own
  correctness.
- **CDK assertions (`cdk synth` + template assertions)** were chosen because they are the
  only way to verify infrastructure-as-code correctness — IAM policy shape, resource
  wiring, no wildcard grants — without creating any cloud resource. `cdk synth` runs
  entirely offline against a dummy account/region; it proves the CloudFormation
  **would** be valid, which is a real and necessary check, but it is explicitly not
  claimed to prove the stack **works** once deployed.
- **Mock Bedrock** (`MockTransport` in `evaluation/transports.ts`) was chosen because
  calling the real Bedrock Converse API costs money per token and requires a working AWS
  credential that is not currently available. The mock transport still runs the real
  `generateHandler`/`getRequestHandler` code in-process — only the Bedrock/DynamoDB SDK
  calls are stubbed — so application-layer validation, error handling, and the
  guardrail-intervention code path are genuinely exercised. What it cannot and does not
  claim to prove is real model quality, relevance, or the real guardrail's actual
  block/anonymise decision — those are reported as `skipped`, not faked as a pass.
- **GitHub Actions** was chosen as the zero-cost way to prove reproducibility — that
  these results hold on a neutral runner, not just "on my machine" — again without any
  AWS account or credential. It genuinely strengthens the evidence (closing the
  works-for-me gap) but is explicitly not a deployment: no AWS resource was created or
  touched by either CI run.

**This is a real engineering trade-off, not a shortcut dressed up as one.** The project
could be deployed for a few dollars of AWS usage, but the explicit goal for this A3
evidence pass was maximum verification rigor at zero cloud cost — and the four choices
above are the combination that gets closest to real AWS behaviour without crossing that
line. Local verification is not represented anywhere in this repository's documentation
as equivalent to a real AWS deployment; §6 above states exactly where that line is.

## 8. Future Validation Plan

In priority order, contingent on obtaining a working (non-rejected) AWS credential:

1. Resolve the AWS credential issue (`docs/deployment-readiness.md` has the exact
   diagnosis) and run a real `cdk deploy` in an isolated, cost-controlled account/region.
2. Capture the specific live-only evidence items already listed in
   `docs/evidence-guide.md` as "requires deployment": a real Bedrock Converse response,
   a real guardrail block/anonymise decision, a real API Gateway SigV4 rejection, a real
   CloudWatch log/metric/trace, and a live IAM role console check.
3. Implement a groundedness scorer — but only once a retrieval/context-grounding feature
   exists for it to check against; adding a scorer with nothing to measure would be a
   cosmetic metric, not real evidence.
4. Tear down all deployed resources immediately after capturing evidence, to keep any
   eventual AWS cost bounded and time-limited rather than an ongoing spend.
