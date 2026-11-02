# UTS 43030 — Assessment 3 Portfolio Evidence: Secure AWS Serverless Generative AI Application

> **Note on authorship**: the technical sections of this document (1–5, 7, 9) describe
> work that was actually done and can be independently checked against the repository.
> Section 6 and parts of Section 8 contain first-person reflective statements that are
> marked **[DRAFT — REVIEW AND REVISE BEFORE SUBMISSION]**. Those statements were
> drafted on the author's behalf based on what the repository and its test history show,
> but a reflection is only honest if it comes from the person who did the learning —
> please read, correct, and rewrite those paragraphs in your own voice before this is
> submitted.

**Repository**: `43030-aws-serverless-genai` (local path `aws-ability`)
**Branch**: `feat/uts-a3-aws-evidence`
**Review date**: 2026-11-02

---

## 1. Project Overview and Professional Goal

This project implements a secure, serverless generative AI request service on AWS:
Amazon API Gateway receives a prompt, an AWS Lambda function validates it and calls
Amazon Bedrock (via the Converse API) with an attached Bedrock Guardrail, and the
result — metadata only, never the raw prompt — is persisted to Amazon DynamoDB. The
whole stack is defined as AWS CDK (TypeScript) infrastructure-as-code.

It was built to satisfy A1 Goal 4: *"Build and evaluate a secure AWS serverless
generative AI application,"* as part of a professional learning plan aimed at three
overlapping career directions: **Senior Software Engineer**, **Cloud Engineering**, and
**Applied AI Engineering**. The project was deliberately scoped to touch all three: the
IAM/API/data-layer design work is cloud engineering; the Bedrock integration, Guardrail
configuration, and evaluation harness are applied AI engineering; and the overall
discipline — typed infrastructure, automated testing, CI, and now a dedicated local
verification layer — is the kind of engineering rigor expected of a senior individual
contributor regardless of which of the three directions a given job title emphasises.

## 2. Why I Chose This Development Activity

**[DRAFT — REVIEW AND REVISE BEFORE SUBMISSION]**

I chose to build a real, non-trivial AWS service rather than a tutorial-following demo
because the roles I am targeting all expect the ability to design and defend
infrastructure decisions, not just use a managed AI API from a notebook. A serverless
generative AI service forces several decisions that a toy project would not: how to
keep IAM permissions minimal when the exact Bedrock resource ARN shape depends on
whether the configured model id is a foundation model or a cross-region inference
profile; how to prevent a prompt from ending up in logs or a database record while still
keeping the system debuggable; and how to design an evaluation method that is honest
about what it can and cannot measure without a live model call. These are the kinds of
problems I expect to face in a cloud/AI engineering role, and I wanted evidence that I
had actually solved them, not just read about them.

## 3. Technical Architecture

```
Client --(SigV4-signed HTTPS)--> API Gateway (AWS_IAM auth, request validator, throttle)
                                       |
                                       v
                              AWS Lambda (Node.js 22, ARM64, X-Ray active tracing)
                                  |                              |
                                  v                              v
                      Amazon Bedrock (Converse API,      Amazon DynamoDB
                      Guardrail attached)                (on-demand, TTL, SSE)
```

- **AWS CDK (TypeScript)** — `lib/serverless-genai-stack.ts` defines every resource;
  nothing is created by hand. Configuration (model id, token limits, throttle rates,
  guardrail toggle) is externalised to CDK context (`cdk.json`), not hard-coded.
- **AWS Lambda** — two functions: `generate` (validates, calls Bedrock, persists) and
  `get-request` (retrieves a stored record). Both are plain Node.js handlers with no
  framework, bundled by `esbuild` via `NodejsFunction`.
- **Amazon API Gateway** — a REST API with `AWS_IAM` authorisation (callers must hold
  valid AWS credentials with `execute-api:Invoke`), a JSON Schema request validator, and
  conservative throttling (5 rps / burst 10).
- **Amazon DynamoDB** — a single on-demand table, partition key `requestId`, TTL-based
  expiry, and a deliberate data-minimisation decision: the raw prompt is never stored,
  only its length and a one-way SHA-256 fingerprint.
- **Amazon Bedrock** — the Converse API (not the older `InvokeModel`), so the model id
  can change without a code change, plus a `CfnGuardrail` with content-safety and
  PII-handling policies defined entirely in CDK.
- **IAM** — every Lambda is granted single DynamoDB actions (`PutItem` *or* `GetItem`,
  never both, never `grantReadWriteData`) and Bedrock access scoped to the exact
  configured model/inference-profile ARN, never a wildcard.
- **CloudWatch + X-Ray** — structured JSON logging with a defined error taxonomy, two
  alarms (Lambda errors, API 5xx), one operations dashboard, and active X-Ray tracing on
  both functions.

Full detail, including rejected alternatives: `docs/architecture.md`.

## 4. Implementation and Verification Evidence

The project is organised around a principle that recurs throughout its documentation:
**state what was actually verified, and how, rather than what is merely believed to be
true.** Three layers of verification exist, each proving something different:

| Layer | What it proves | What it cannot prove |
|---|---|---|
| 155 fully-mocked unit/infrastructure tests (`test/*.test.ts`, pre-existing) | Application logic is correct against the exact inputs/outputs a mock is told to produce; the synthesised CloudFormation template has the expected shape | That a real DynamoDB/Bedrock call would actually succeed with that shape of request |
| 18 local-DynamoDB tests added for this review (`test/local-integration.test.ts`, `test/local-security.test.ts`) | The real DynamoDB wire calls (`PutCommand`, `GetCommand`, `ConditionExpression`) are well-formed against a real DynamoDB-API-compatible engine (`amazon/dynamodb-local`), not just an obedient mock | Anything about AWS Cloud DynamoDB specifically (billing, replication, real latency) or about Amazon Bedrock, API Gateway, or IAM, none of which DynamoDB Local touches |
| `cdk synth`, `evaluate:mock`, `npm audit` | The infrastructure-as-code is valid CloudFormation; the evaluation harness's own scoring logic is internally consistent; the production dependency tree has no unaddressed high-severity CVEs | Anything about what happens when this is actually deployed |

**Current, reproduced-fresh-on-2026-11-02 numbers** (see
`docs/uts-a3-goal4-evidence.md` "Reproducible Evidence Log" for the full command output):

- `npm run lint` / `npm run typecheck`: clean.
- `npm test` with DynamoDB Local running: **173 tests, 171 passed, 2 skipped** (the 2
  skips are deliberate documentation entries, not failures).
- `cdk synth` (dummy account/region, no AWS credentials involved): succeeds, producing a
  20-resource-type CloudFormation template.
- `npm run evaluate:mock`: 13/13 cases with no failing dimension; 20 dimension checks
  pass, 0 fail, 16 skip (skips are the dimensions — relevance, format, latency — that
  genuinely cannot be judged without a real model call, and are reported as `skipped`
  rather than faked as a pass).

**What none of the above proves, stated directly**: that this service works when
actually deployed to AWS. No `cdk deploy` has ever succeeded against a real account (see
`docs/deployment-readiness.md` for why — a rejected, not merely absent, local AWS
credential), so no real Bedrock response, no real API Gateway authorisation rejection, no
real CloudWatch log, and no real Guardrail block has ever been observed. This is stated
as plainly here as it is in every other document in this repository.

## 5. Security and Reliability Decisions

- **Least privilege as a tested property, not a review checklist item.** IAM grants are
  single actions (`table.grant(generateFunction, 'dynamodb:PutItem')`, never a combined
  read/write grant), and `test/infrastructure.test.ts` asserts directly against the
  synthesised policy document that no wildcard action or resource ever appears. This
  means a future change that widens a permission fails CI (once CI is actually wired to
  run against this branch — see the CI finding below), not just code review.
- **Data minimisation by construction.** `src/shared/repository.ts`'s `RequestRecord`
  type has no `prompt` field at all — only `promptLength` and `promptFingerprint` (a
  one-way hash). This was re-verified in this review not against the API response (which
  was never going to contain it either way) but against the **raw stored DynamoDB item**,
  which is the only place a leak could actually hide.
- **Error sanitisation as a type-level concern.** `AppError` separates an internal
  message (logged) from a `clientMessage` (returned to the caller) at the type level, so
  a developer cannot accidentally return internal detail without deliberately bypassing
  the type.
- **Defence in depth that is honestly scoped.** Prompt-injection and sensitive-data
  detection exist at the application layer (regex heuristics) *and* are intended to be
  backed by a real Bedrock Guardrail. `docs/security.md` and this review both state the
  same thing: the application-layer heuristics are a mitigation, not a boundary, and are
  trivially bypassable by rephrasing. This review additionally confirmed something
  `docs/security.md` had not previously stated as precisely: because the mock Bedrock
  client always succeeds, the guardrail-blocking code path (`stopReason ===
  "guardrail_intervened"`) had never been exercised by any test until this review added
  one that simulates it — meaning the *application's handling* of a block is now tested,
  while the *real guardrail's decision* to block anything specific remains unverified.
- **Fail-safe local test design.** The new local-DynamoDB test suite cannot accidentally
  reach a real AWS endpoint: every AWS SDK client is pointed at a local container via
  `AWS_ENDPOINT_URL_DYNAMODB` with deliberately fake credentials, and a reachability
  probe skips the whole suite (rather than hanging or silently passing) if the container
  isn't running. This is itself a reliability decision worth naming: the tests are
  designed to fail safe, not just to pass when everything happens to be configured
  correctly.

## 6. Challenges and Lessons Learned

**[DRAFT — REVIEW AND REVISE BEFORE SUBMISSION. The factual claims below are accurate;
the framing of what I personally found difficult or learned is my best guess at your
experience from the repository history, not something I can actually know. Please rewrite
this in your own words.]**

The hardest part of this review was not writing new code — the existing implementation
was already well-designed — but resisting the pull to make the evidence *look* more
complete than it actually was. Two specific moments stand out:

1. When I first wrote local DynamoDB tests, I asserted that a mock-mode response should
   never contain the original prompt text — and the test failed, because the mock
   deliberately echoes part of the prompt back as a demo convenience. My first instinct
   was that this was a privacy bug. It wasn't: the actual guarantee the system makes is
   "no raw prompt attribute in the stored database record," not "no response ever
   contains words from the prompt." Fixing the test (to check the real stored item
   instead of the API response) rather than quietly loosening the assertion to make it
   pass taught me the difference between a test that's green and a test that's *correct*.
2. When checking whether CI had actually run these new tests, the honest answer turned
   out to be "CI never ran at all on this branch" — not "the DynamoDB-dependent tests
   skipped in CI," which is what I assumed before checking. The branch name
   `feat/uts-a3-aws-evidence` simply doesn't match the workflow's trigger pattern
   (`feature/**`). It would have been easy to write "CI confirms..." from memory of how
   CI behaved on a *different* branch in an *earlier* review pass. Catching this required
   actually running `gh run list` scoped to this exact branch, not assuming continuity
   from a previous finding.

Both moments reinforced the same lesson: in a security- and evidence-sensitive project,
the discipline of re-checking a claim against the actual current state — rather than
reusing a plausible-sounding one from memory or from a slightly different mock — matters
more than the amount of code written.

## 7. Comparison Against My Original A1 Plan

A1 Goal 4 planned twelve areas. Status after this review, using the vocabulary defined
in `docs/uts-a3-goal4-evidence.md`:

| A1 Planned Area | Status |
|---|---|
| AWS Serverless Architecture | MOCK VERIFIED (synthesised, not executed in any cloud) |
| AWS CDK with TypeScript | LOCALLY VERIFIED |
| AWS Lambda | LOCALLY VERIFIED (handler logic only, not a real Lambda runtime) |
| Amazon API Gateway | MOCK VERIFIED (synthesised config only) |
| Amazon DynamoDB | **LOCALLY VERIFIED against a real local engine** (not AWS Cloud DynamoDB) |
| Amazon Bedrock Integration | MOCK VERIFIED (response-shape only) |
| Bedrock Guardrails / AI Safety | MOCK VERIFIED (app-layer shape only) |
| IAM Least Privilege / Security | MOCK VERIFIED (synthesised policy only) |
| LLM Evaluation — Relevance, Prompt Injection, Sensitive Data, Latency, Failure Behaviour | Mixed — see the full matrix; Failure Behaviour is the strongest, Relevance/Latency are NOT VERIFIED |
| LLM Evaluation — **Groundedness** | **NOT EVALUATED** — planned, but the harness never implemented a scorer for it |
| CloudWatch / OpenTelemetry Observability | MOCK VERIFIED (config only; also: AWS-native CloudWatch+X-Ray, not OpenTelemetry SDK) |
| Automated Tests and CI/CD | LOCALLY VERIFIED by direct execution; **CI itself has never run on this branch** |
| Architecture Documentation and Portfolio Evidence | **IMPLEMENTED** — this is the most complete area of the original plan |

**The honest summary**: everything that can be verified without an AWS account has now
been verified, often more rigorously than the original plan anticipated (the local
DynamoDB engine work was not in the original A1 plan at all — it emerged from asking
"what does mocking actually fail to prove?"). Everything that genuinely requires a live
AWS account remains exactly where it was at the start of this review: blocked on a
rejected local credential, not on missing design or code.

## 8. Limitations and Future Development

**Technical limitations (verified facts):**

- No real AWS deployment has ever succeeded. `docs/deployment-readiness.md` diagnoses
  the blocker precisely: the local AWS credential returns `InvalidClientTokenId`, which
  means the access key itself is rejected, not merely absent or expired in a recoverable
  way.
- Groundedness has no scorer in the evaluation harness at all — a code-level gap, not a
  deployment gap, and the one genuinely "not started" item in the whole project.
- CI (`validate.yml`) has never executed against any commit on this branch, for a
  specific, fixable reason (the branch-name pattern doesn't match the trigger). This
  means every "it still works" claim in this project currently rests on local execution
  only.
- API Gateway, the real Bedrock Guardrail's filtering/anonymisation decision, and real
  CloudWatch/X-Ray telemetry have never been exercised in any form — local or cloud —
  because nothing in this project emulates API Gateway or Bedrock locally.

**Future development, in priority order:**

1. Resolve the AWS credential and run a real `cdk deploy`, then capture the specific
   evidence items `docs/evidence-guide.md` already lists as "requires deployment" (E4–E10,
   parts of E13/E15).
2. Either rename this branch to match the CI trigger pattern or widen the workflow's
   trigger so that future pushes here actually run CI — and, ideally, add a `services:`
   block provisioning DynamoDB Local in CI so the new local-DynamoDB suite runs there too,
   not just on a developer machine.
3. Implement a groundedness scorer once (and only if) a retrieval/context feature exists
   for it to check against — adding one without a grounding source would just be a
   cosmetic metric.

**[DRAFT — REVIEW AND REVISE: the prioritisation above is my judgement of what matters
most for the assessment; you may reasonably disagree with the order, especially if your
own time constraints before the deadline favour a different sequence.]**

## 9. Direct Links to Verifiable Evidence

All links point at the pushed, reviewable state of this branch.

- **Branch**: `https://github.com/krischuang/43030-aws-serverless-genai/tree/feat/uts-a3-aws-evidence`
- **Commits referenced in this document**:
  - `https://github.com/krischuang/43030-aws-serverless-genai/commit/187541a`
  - `https://github.com/krischuang/43030-aws-serverless-genai/commit/19f225f`
  - `https://github.com/krischuang/43030-aws-serverless-genai/commit/8e87911`
  - `https://github.com/krischuang/43030-aws-serverless-genai/commit/cfd60c7`
- **Evidence documents** (all in this repository, this branch):
  - `docs/uts-a3-goal4-evidence.md` — the full per-requirement matrix and the CI finding
  - `docs/local-evaluation-report.md` — Pass/Fail/Skip/Not-Evaluated breakdown
  - `docs/local-validation-guide.md` — how to reproduce everything above, including the
    safety design that prevents an accidental real-AWS call
  - `docs/deployment-readiness.md` — the diagnosed AWS credential blocker
  - `docs/architecture.md`, `docs/security.md`, `docs/evaluation.md`,
    `docs/evidence-guide.md`, `docs/professional-reflection.md` — the pre-existing
    design, security, and evaluation documentation this review built on
- **Test source** (what was actually run, not a description of it):
  - `test/local-integration.test.ts`, `test/local-security.test.ts`,
    `test/local-dynamodb-helper.ts`
  - `test/infrastructure.test.ts`, `test/generate-handler.test.ts` (pre-existing,
    re-verified in this review)
- **Infrastructure source**: `lib/serverless-genai-stack.ts`, `lib/bedrock-permissions.ts`,
  `lib/stack-config.ts`
