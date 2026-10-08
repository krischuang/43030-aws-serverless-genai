# Architecture

This document records what was built, why each component was chosen, what was rejected,
and what would change if the project were taken further. It is written so a reviewer can
follow the reasoning without reading the code first.

## 1. Context and constraints

The system is a university professional-learning artefact, not a product. That shaped
every decision:

| Constraint | Consequence |
| --- | --- |
| Must demonstrate breadth across a named capability list | Every layer present, each layer small |
| Must be cheap enough to deploy and destroy repeatedly | Serverless, on-demand, nothing always-on |
| Must be readable end to end by a marker | Two endpoints, two Lambdas, ~1,200 lines of source |
| Must be reproducible by someone else | 100% IaC, pinned lock file, no manual console steps |
| Must be honest about what is and is not production-grade | Limitations documented beside the controls |
| Must not depend on model access that may be unavailable | A documented, clearly-labelled mock mode |

## 2. Component decisions

### 2.1 API Gateway REST, not HTTP API

HTTP APIs are cheaper and faster, and both support IAM authorisation. REST was chosen
because it provides three things this project needs as *evidence*:

- **Request validators and JSON schema models** — declarative input validation at the
  edge, before compute is billed. HTTP APIs have no equivalent.
- **Stage-level method throttling** — a rate and burst ceiling expressed in IaC.
- **Structured access logging with a custom field format** — selectable fields, so the
  access log contains request id, status, latency and caller account but *not* bodies.

The trade-off is a slightly higher per-request price and marginally higher latency. At
this volume that is irrelevant; the demonstrable controls are worth more.

### 2.2 Two Lambda functions, not one router

Separate functions for `POST /generate` and `GET /requests/{requestId}` exist so that the
IAM policies can differ. The generate function holds `dynamodb:PutItem` and
`bedrock:InvokeModel`; the retrieval function holds `dynamodb:GetItem` and nothing else.
A single router Lambda would need the union of both, which would make "least privilege"
a claim rather than a property. Different timeouts (30 s vs 10 s) and memory sizes
(512 MB vs 256 MB) follow from the same separation.

ARM64 was chosen for its lower per-millisecond price; the Node.js 22 runtime because
Node.js 20 was deprecated for Lambda in April 2026.

### 2.3 Bedrock Converse API, not InvokeModel

`InvokeModel` requires a model-family-specific request body — Anthropic, Amazon Nova and
Meta all differ. `Converse` normalises the request and response, which is what makes the
model id genuine *configuration*: `bedrockModelId` can change from a Nova profile to an
Anthropic model with no code change. It also exposes `usage` tokens, `metrics.latencyMs`
and a `stopReason` of `guardrail_intervened` uniformly, which the handler uses for
observability and error classification.

Streaming (`ConverseStream`) was rejected: it would require a streaming-capable response
path (Lambda response streaming or WebSockets), which adds material complexity for no
learning gain at this scale.

### 2.4 Model selection and ARN resolution

The default is `apac.amazon.nova-micro-v1:0` — the Asia-Pacific cross-region inference
profile for Amazon Nova Micro, the cheapest text model generally available in
`ap-southeast-2`.

Bedrock has two addressing styles, and they need different IAM resources:

| Style | Example | Required resource ARNs |
| --- | --- | --- |
| Foundation model | `amazon.nova-micro-v1:0` | `arn:aws:bedrock:<region>::foundation-model/<id>` |
| Cross-region inference profile | `apac.amazon.nova-micro-v1:0` | the account-scoped `inference-profile/<id>` **and** `foundation-model/<base-id>` with a region wildcard |

`lib/bedrock-permissions.ts` distinguishes them by segment count (three dot-separated
segments means a geography prefix is present) and emits only the ARNs that style needs.
This is the single most error-prone part of the stack: getting it wrong produces an
`AccessDeniedException` that is invisible until a live invocation, which is exactly why
it is isolated in its own module with its own tests.

### 2.5 DynamoDB

| Setting | Value | Reasoning |
| --- | --- | --- |
| Partition key | `requestId` (string, UUID v4) | Every access is a point lookup by id; no secondary index is needed |
| Billing | `PAY_PER_REQUEST` | Idle cost zero; no capacity planning for unpredictable demo traffic |
| Encryption | `AWS_MANAGED` | Explicit SSE with the `aws/dynamodb` KMS key, which carries no monthly charge; the default AWS-owned key would also encrypt but is less visible as evidence |
| TTL | `ttl` attribute, 7 days | Demo records self-delete; the attribute is set by the application, so retention is configuration |
| Point-in-time recovery | Disabled | The data is disposable demo metadata; continuous backup would bill for no benefit |
| Removal policy | `DESTROY` | A learning stack must be fully removable; retaining the table would leave an orphan after `cdk destroy` |

**Data minimisation is the notable decision here: the raw prompt is never stored.** Only
`promptLength` and a 12-hex-character SHA-256 fingerprint are persisted. That is enough to
correlate repeated prompts and analyse evaluation runs, and it means the table cannot
become an accidental store of user-supplied text. The generated response *is* stored,
because returning it from `GET /requests/{requestId}` is the point of the endpoint.

Failure records are written too (`status: "failed"` or `"blocked"`, with an `errorCode`),
so error rates are visible in the data store as well as in CloudWatch — but only for
failures that reached the model. Validation rejections are deliberately not persisted:
they never incurred a model call, and writing them would let cheap malformed requests
inflate the table.

The write uses `ConditionExpression: attribute_not_exists(requestId)`, making it
idempotent and surfacing any UUID collision rather than silently overwriting.

### 2.6 Guardrail

A Bedrock guardrail is provisioned through `CfnGuardrail` + `CfnGuardrailVersion` with a
content policy (hate, violence, sexual, insults, misconduct, prompt attack) and a
sensitive-information policy (AWS keys, passwords and card numbers blocked; email and
phone anonymised). It is attached to the Converse call via `guardrailConfig`, and
`bedrock:ApplyGuardrail` is scoped to that guardrail's ARN alone.

It is behind the `enableGuardrail` context flag, defaulting to true, because guardrail
creation requires `bedrock:CreateGuardrail` which some accounts do not grant. With the
flag off, no guardrail resources are created, no guardrail permission is granted, and
application-level validation is unchanged — so the stack remains deployable in a
restricted account without editing code.

Guardrails bill per text unit evaluated, which at this prompt size and volume is
negligible, and nothing while idle.

### 2.7 Configuration strategy

No value that might differ between environments is hard-coded. `cdk.json` context feeds
`lib/stack-config.ts`, which validates and defaults each value; the stack injects them as
Lambda environment variables; `src/shared/config.ts` reads them at invocation time.

Reading configuration per invocation rather than at module scope is deliberate: a missing
or malformed variable then surfaces as a handled `500` with a safe message and a
structured error log, rather than as a Lambda init crash with a stack trace. It also lets
the test suite vary the environment per test.

No secret store is used, because there are no secrets — every configuration value is
non-sensitive. Introducing Secrets Manager to hold nothing would be security theatre.

### 2.8 Error taxonomy

`src/shared/errors.ts` defines one error class per failure category, each carrying a
stable `code`, an HTTP `statusCode`, a `category` for log aggregation, and — critically —
a separate `clientMessage` and internal `message`. The internal message may contain the
AWS exception name, the table name, or the failure detail; `errorResponse()` serialises
only `code` and `clientMessage`. This is asserted by tests that check specific strings
(`AccessDenied`, `arn:aws:iam`, the table name) never appear in a response body.

### 2.9 Logging design

`src/shared/logger.ts` emits one JSON object per line. Two design points matter:

1. **Redaction is structural, not procedural.** `prompt`, `response`, `token`, `secret`,
   `password`, `authorization` and similar field names are on a deny-list inside the
   logger. A developer who logs `{ prompt }` out of habit gets `"prompt":"[redacted]"`,
   not a leak. Long strings are truncated at 256 characters and `Error` objects are
   reduced to name and message so stack traces never reach the log stream.
2. **Correlation is mandatory, not optional.** Every line carries `service`, `operation`,
   `environment`, the application `requestId` and the API Gateway `correlationId`, so one
   request can be followed across the access log, the execution log and the application
   log.

A dependency-free logger was chosen over Powertools for AWS Lambda. Powertools would give
more (EMF metrics, tracer integration, idempotency) but would also obscure the mechanics
being demonstrated behind a decorator. For a learning artefact, 130 readable lines that
show exactly how structured logging and redaction work is the better trade; Powertools is
listed as an extension below.

### 2.10 Observability choices

Active X-Ray tracing on both functions and the API stage gives end-to-end API→Lambda
traces with no code change. AWS SDK calls are *not* instrumented as subsegments, so
Bedrock and DynamoDB timings appear in structured logs (`modelLatencyMs`, `durationMs`)
rather than as trace segments. This is a conscious trade — adding `aws-xray-sdk-core`
would close the gap at the cost of bundle size and a wrapper around every client — and is
stated as a limitation rather than glossed over.

Two alarms (Lambda errors, API 5XX) and one dashboard sit inside the CloudWatch free
tier. Alarms publish to an SNS topic with no subscription: the wiring is correct and
visible as IaC, and an operator adds their own endpoint. `dataTraceEnabled` is explicitly
`false` on the stage, because enabling it writes full request and response bodies to
CloudWatch — which would put user prompts in logs and defeat the redaction work.

### 2.11 Bundling

`NodejsFunction` bundles with esbuild, minified, with inline source maps and
`NODE_OPTIONS=--enable-source-maps`. `externalModules: []` forces the AWS SDK to be
bundled rather than taken from the runtime image. That trades roughly 500 KB of bundle
size and a little cold-start time for a deployment that is reproducible against the
pinned SDK version in `package-lock.json`, instead of against whatever SDK version the
Lambda runtime image happens to carry that month. For a project whose stated goal
includes reproducible deployment, that is the right side of the trade.

`AWS_MAX_ATTEMPTS=2` bounds SDK-internal retries so a Bedrock outage cannot hold the
function open for its full 30-second timeout.

## 3. Request lifecycle

```
POST /generate
  │
  ├─ API Gateway: SigV4 signature check (AWS_IAM) ──────────── 403 if unsigned/invalid
  ├─ API Gateway: stage throttle (5 rps, burst 10) ─────────── 429 if exceeded
  ├─ API Gateway: JSON schema validation ───────────────────── 400 if shape/length invalid
  │
  └─ Lambda (generate)
       ├─ loadConfig()                      ─ 500 INTERNAL_ERROR on misconfiguration
       ├─ parseBody()                       ─ 400 EMPTY_BODY | MALFORMED_JSON | BODY_TOO_LARGE
       ├─ validateGenerateRequest()         ─ 400 EMPTY_PROMPT | PROMPT_TOO_LONG | ...
       ├─ detectSafetyFlags()               ─ annotates; never rejects
       ├─ log "request accepted"            ─ length + fingerprint + flags, never the text
       ├─ Bedrock Converse (+ guardrail)    ─ 422 CONTENT_BLOCKED | 502 MODEL_UNAVAILABLE
       ├─ DynamoDB PutItem (TTL set)        ─ 503 PERSISTENCE_FAILURE
       ├─ log "request completed"           ─ status, duration, tokens, stopReason
       └─ 200 { requestId, response, modelId, createdAt, metadata }

On any failure: one ERROR log line with errorCategory/errorCode, a best-effort failure
record (except validation and configuration faults), and a safe error response.
```

## 4. Rejected alternatives

| Alternative | Why it was rejected |
| --- | --- |
| Amazon Cognito user pools | A full identity platform for a two-endpoint demo; IAM auth demonstrates the authorisation concept at a fraction of the surface area. The gap this leaves is documented, not hidden. |
| API keys + usage plans | Weaker than SigV4 (a static shared secret), and would need a secret-distribution story |
| Lambda authorizer | Custom auth code is more to get wrong than a managed authoriser, with no learning gain here |
| Step Functions orchestration | No multi-step workflow exists to orchestrate |
| Aurora Serverless / RDS | Relational storage for a single point-lookup access pattern; also not free at idle |
| S3 for response bodies | Responses are a few hundred tokens; DynamoDB handles them well within item limits |
| EventBridge async pipeline | Would improve resilience but removes the synchronous response the API contract needs |
| Response streaming | Requires a different response path for no assessable benefit |
| Powertools for AWS Lambda | Hides the logging/tracing mechanics this project exists to demonstrate |
| CloudFront in front of the API | Adds cost and a caching layer with no benefit for authenticated, non-idempotent POSTs |
| `cdk-nag` | Valuable, but its findings would need per-rule suppression documentation that would outweigh the artefact's size |

## 5. Extensions, in priority order

If this were taken beyond a learning artefact:

1. **Real end-user authentication** — Cognito or an external OIDC provider, with per-user
   quotas and consent records. This is the largest gap.
2. **X-Ray SDK instrumentation** — subsegments for Bedrock and DynamoDB so model latency
   is visible in a trace, not only in logs.
3. **Prompt/response storage policy** — if prompts must be retained, an explicit consent
   model, a shorter TTL, a customer-managed KMS key and documented retention.
4. **Model-graded evaluation** — a second model scoring response quality, lifting the
   relevance dimension beyond keyword matching.
5. **Multi-environment pipeline** — `dev`/`staging`/`prod` stages with CDK Pipelines and
   stage-scoped deployment roles.
6. **Response caching / idempotency keys** — avoid paying for identical repeated prompts.
7. **`cdk-nag` in CI** — automated IaC security rules with documented suppressions.
8. **Load and soak testing** — turn single-call latency figures into a distribution.
9. **WAF on the API** — rate-based rules and geo controls, once the endpoint is public.
10. **Powertools migration** — EMF custom metrics (tokens per request, safety flags per
    minute) without hand-rolled metric publishing.

## 6. Capability-to-code map

| Required capability | Primary evidence |
| --- | --- |
| AWS Lambda | `src/handlers/generate.ts`, `src/handlers/get-request.ts` |
| Amazon API Gateway | `lib/serverless-genai-stack.ts` → `createApi`, `createRequestModel` |
| Amazon DynamoDB | `lib/serverless-genai-stack.ts` → `RequestTable`; `src/shared/repository.ts` |
| AWS CDK TypeScript | `bin/app.ts`, `lib/*.ts` |
| Amazon Bedrock | `src/shared/bedrock.ts` |
| Infrastructure as Code | Entire `lib/`; `cdk synth` gated in CI |
| Least-privilege IAM | `lib/bedrock-permissions.ts`; `table.grant(fn, '<single action>')`; `test/infrastructure.test.ts` IAM suite |
| Input validation / AI safety | `src/shared/validation.ts`; guardrail; `SYSTEM_PROMPT` |
| CloudWatch logging/metrics/tracing | `src/shared/logger.ts`; `createAlarms`, `createDashboard`; `Tracing.ACTIVE` |
| Automated testing | `test/` — 155 tests, 8 suites |
| CI/CD | `.github/workflows/validate.yml`, `deploy.yml` |
| Structured AI evaluation | `evaluation/` + `docs/evaluation.md` |
| Architecture documentation | This file, `docs/security.md`, `README.md` |
| Reproducible deployment | `package-lock.json`, `cdk.json` context, documented deploy and destroy |
