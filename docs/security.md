# Security

This document states what is protected, how, and — equally important — what is not. A
portfolio artefact that overstates its security posture is worse evidence than one that
does less and says so.

## 1. Threat model

In scope for a demonstration service of this shape:

| # | Threat | Control | Residual risk |
| --- | --- | --- | --- |
| T1 | Anonymous internet caller invokes the endpoint | `AWS_IAM` authorisation (SigV4 required) | Any principal in the account with `execute-api:Invoke` can call it; there is no per-user authorisation |
| T2 | Compromised Lambda role used to reach other resources | Least-privilege policies: one DynamoDB action per function, Bedrock scoped to one model | X-Ray requires `Resource: "*"` (no resource-level permissions exist for that service) |
| T3 | Oversized or malformed input causing cost or crashes | Edge JSON schema, 8 KiB body ceiling, length/type/control-character validation | API Gateway's own 10 MB payload cap cannot be lowered; the handler ceiling is the real limit |
| T4 | Prompt injection / instruction override | Pinned system prompt, guardrail `PROMPT_ATTACK` filter, regex flagging, output never executed | Mitigation only — not a security boundary; heuristics are bypassable by rephrasing |
| T5 | Sensitive data landing in logs | Structural redaction in the logger, `dataTraceEnabled: false`, prompt never persisted | A model response could echo user-supplied sensitive content into the stored record |
| T6 | Internal detail leaking in error responses | Separate `clientMessage` / internal `message`; asserted by tests | — |
| T7 | Denial of wallet via high request volume | Stage throttling 5 rps / burst 10, `maxTokens` 400, `maxPromptLength` 2000 | No per-principal quota; no AWS Budgets alarm is provisioned by the stack |
| T8 | Data at rest exposure | DynamoDB SSE with the AWS managed key; 7-day TTL | AWS managed key, not a customer-managed key with its own rotation and key policy |
| T9 | Data in transit interception | TLS-only API Gateway endpoint; `enforceSSL` on the SNS topic | — |
| T10 | Credential exposure in the repository | No secrets in code or config; OIDC for CI deployment; `evidence/` git-ignored | Depends on the operator not committing `cdk-outputs.json` or evidence files (both ignored) |
| T11 | Path-parameter abuse to probe storage | UUID v4 validation before any DynamoDB call | — |
| T12 | Supply-chain compromise via dependencies | Pinned `package-lock.json`, `npm ci` in CI, Dependabot, clean production audit | Known dev-tooling advisories with no published fix (see §7) |

Explicitly out of scope: DDoS absorption beyond API Gateway defaults, multi-tenancy
isolation, data-residency guarantees, and regulatory compliance (no personal data is
intentionally processed or retained).

## 2. Authentication and authorisation

### 2.1 Why IAM authorisation

Both methods set `authorizationType: AuthorizationType.IAM`. Requests must be SigV4-signed
by a principal holding `execute-api:Invoke` on the method ARN; unsigned requests receive
`403` from API Gateway and never reach compute.

This was chosen over the alternatives because it is **AWS-native, zero-infrastructure, and
genuinely strong for the threat it addresses** (T1):

| Option | Why not chosen |
| --- | --- |
| Cognito user pool | A complete identity platform — user pool, app client, hosted UI or token flow, token validation — for a two-endpoint demonstration. Large surface area, little marginal learning. |
| API key + usage plan | A static shared secret. Weaker than SigV4, and needs a distribution and rotation story the project would then have to tell. |
| Lambda authorizer | Hand-written authorisation logic: more to get wrong than a managed authoriser, with no gain at this scale. |
| No authorisation | Not acceptable. An unauthenticated endpoint that spends money on model inference is a denial-of-wallet vulnerability by construction. |

### 2.2 What IAM authorisation does not give

Stated plainly: **this is not production end-user authentication.** It authenticates an
*AWS principal*, not an application user. There is no concept of a user account, a login,
a session, consent capture, or a per-user rate limit or quota. Any IAM principal in the
account that has been granted `execute-api:Invoke` can call the API with equal privilege,
and the service cannot distinguish one caller from another beyond the account id recorded
in the access log.

For a real multi-user service, item 1 of the extensions list in `docs/architecture.md`
(Cognito or an external OIDC provider, with per-user quotas) is the required work.

### 2.3 Lambda execution roles

Synthesised policy for the generate function:

| Action | Resource | Note |
| --- | --- | --- |
| `dynamodb:PutItem` | the request table ARN | Write only — this function cannot read the table |
| `bedrock:InvokeModel` | `inference-profile/apac.amazon.nova-micro-v1:0` and `foundation-model/amazon.nova-micro-v1:0` | Exactly the configured model; no wildcard model access |
| `bedrock:ApplyGuardrail` | the provisioned guardrail ARN | Only when `enableGuardrail` is true |
| `xray:PutTraceSegments`, `xray:PutTelemetryRecords` | `*` | X-Ray has no resource-level permissions; this is an AWS constraint, not a shortcut |
| CloudWatch Logs write | its own log group | Added by CDK for the function's log group only |

For the retrieval function: `dynamodb:GetItem` on the table, X-Ray, and its own log
group. Nothing else — it has no Bedrock permission of any kind.

Note what is absent: no `dynamodb:*`, no `bedrock:*`, no `bedrock:InvokeModel` on `*`, no
cross-resource access, and in `mockBedrock` mode no Bedrock statement at all. This is
enforced by tests in `test/infrastructure.test.ts` that assert the complete set of
DynamoDB actions is exactly `['dynamodb:GetItem', 'dynamodb:PutItem']` across the whole
template and that no Bedrock resource is `*`.

The two functions are separate precisely so these policies can differ (see
`docs/architecture.md` §2.2).

## 3. Input validation

Three layers, cheapest first:

**Layer 1 — API Gateway (before compute is billed).** A request validator with a
draft-4 JSON schema model: `prompt` required, type string, `minLength` 3,
`maxLength` 2000, `additionalProperties: false`. Path parameters are marked required.

**Layer 2 — the handler.** Defence in depth, because the handler is also invocable
directly (tests, console, any future event source):

| Check | Code | Status |
| --- | --- | --- |
| Body present | `EMPTY_BODY` | 400 |
| Body ≤ 8 KiB (UTF-8 bytes) | `BODY_TOO_LARGE` | 400 |
| Valid JSON | `MALFORMED_JSON` | 400 |
| Body is an object, not array/scalar/null | `INVALID_PAYLOAD` | 400 |
| `prompt` present | `MISSING_PROMPT` | 400 |
| `prompt` is a string | `INVALID_PROMPT_TYPE` | 400 |
| Non-empty after trim | `EMPTY_PROMPT` | 400 |
| ≥ 3 characters | `PROMPT_TOO_SHORT` | 400 |
| ≤ `maxPromptLength` characters | `PROMPT_TOO_LONG` | 400 |
| No control characters except tab/newline/CR | `INVALID_CHARACTERS` | 400 |
| `requestId` is a UUID v4 | `INVALID_REQUEST_ID` | 400 |

**Layer 3 — the model boundary.** The guardrail evaluates input before generation and
output before return.

The UUID check on Layer 2 matters more than it looks: it runs *before* any DynamoDB call,
so an arbitrary path value can never be used to probe the table.

## 4. AI safety controls

### 4.1 Implemented

| Control | Mechanism | Boundary or mitigation? |
| --- | --- | --- |
| Empty / whitespace prompt rejection | `validateGenerateRequest` | Boundary |
| Maximum prompt length | Edge schema + handler check | Boundary |
| Malformed JSON handling | `parseBody` → structured 400 | Boundary |
| Conservative generation limits | `maxTokens` 400, `temperature` 0.2 | Boundary (bounds cost and variance) |
| Prompt text never logged | Logger deny-list, `dataTraceEnabled: false` | Boundary |
| Prompt text never persisted | Only length + SHA-256 fingerprint stored | Boundary |
| Clean Bedrock failure handling | `UpstreamModelError` → 502 with a safe message | Boundary |
| Pinned system prompt | `SYSTEM_PROMPT` in `src/shared/bedrock.ts` instructs the model to treat user input as data, never to reveal instructions, never to repeat credentials | **Mitigation** |
| Bedrock guardrail — content policy | Hate/violence/sexual HIGH, insults/misconduct MEDIUM, `PROMPT_ATTACK` HIGH on input | **Mitigation** |
| Bedrock guardrail — sensitive information | AWS access/secret keys, passwords, card numbers BLOCK; email, phone ANONYMIZE | **Mitigation** |
| Guardrail intervention surfaced | `stopReason === 'guardrail_intervened'` → 422 `CONTENT_BLOCKED` | Boundary |
| Injection / sensitive-request flagging | Regex heuristics → `safetyFlags`, recorded and returned | **Mitigation / observability** |

### 4.2 Why flagging rather than blocking

`detectSafetyFlags` annotates a request as `possible_prompt_injection` or
`possible_sensitive_data_request` and lets it proceed. Blocking on a regex would be
security theatre: it is trivially bypassed by rephrasing, and it would reject legitimate
questions ("how do I protect against prompt injection?"). Flagging gives three real
benefits instead: the behaviour becomes *measurable* in the evaluation suite, the flags are
queryable in CloudWatch and DynamoDB for trend analysis, and the defences that do the
actual work (pinned system prompt, guardrail) are the ones being tested.

The honest claim is therefore: **the service observes and reports injection attempts, and
reduces their effect; it is not immune to them.** The evaluation suite's injection cases
(C09, C10) assert observable behaviour — the system prompt is not disclosed, the attempt
is flagged — not immunity.

### 4.3 Guardrail availability

Guardrail provisioning needs `bedrock:CreateGuardrail`, which some accounts do not grant.
`-c enableGuardrail=false` removes the guardrail resources and the `ApplyGuardrail`
permission entirely while leaving every application-level control in place. This is a
tested path (`test/infrastructure.test.ts` asserts zero guardrail resources with the flag
off), not an untested fallback.

## 5. Secrets, error handling and log hygiene

**No secrets exist in this project.** Every configuration value — model id, table name,
limits, retention — is non-sensitive and is injected as a Lambda environment variable by
CDK. There are no API keys, no database passwords, no tokens. Introducing Secrets Manager
to store nothing would add cost and a false impression of secret management.

**Safe error responses.** `AppError` carries both an internal `message` (which may name
the AWS exception, the table, or the failure detail) and a `clientMessage` (which may
not). `errorResponse()` serialises only `{ error: { code, message } }` plus the request
id. Tests assert that `AccessDenied`, `arn:aws:iam`, the table name and raw AWS error
strings never appear in a response body.

**Log sanitisation.** Redaction lives inside the logger, not in a convention:

- Deny-listed field names (`prompt`, `response`, `token`, `secret`, `password`,
  `authorization`, `apiKey`, `credentials`, …) are replaced with `[redacted]` regardless
  of the call site.
- Strings over 256 characters are truncated.
- `Error` values are reduced to `{ name, message }`, so stack traces never reach logs.
- The API Gateway stage sets `dataTraceEnabled: false`; enabling it would write full
  request and response bodies to CloudWatch and defeat all of the above.
- The access log format selects specific fields (request id, method, resource path,
  status, latency, caller account, integration error) — never bodies or headers.

What is logged about a prompt: its character length and a 12-hex-character SHA-256
fingerprint. The fingerprint correlates repeated prompts without being reversible to the
text.

## 6. Encryption, networking and throttling

- **At rest.** DynamoDB server-side encryption with the AWS managed `aws/dynamodb` key
  (no monthly key charge). CloudWatch Logs are encrypted with service-managed keys.
- **In transit.** API Gateway is HTTPS-only. The SNS alarm topic sets `enforceSSL: true`.
- **Networking.** No VPC. The functions reach Bedrock and DynamoDB over the AWS network
  via public service endpoints with IAM authorisation and TLS. A VPC with interface
  endpoints would add NAT or endpoint-hour cost for no security gain at this scale, since
  the functions hold no inbound network surface. For a regulated workload requiring
  traffic never to traverse the public internet, VPC endpoints would be required.
- **Throttling.** Stage-level 5 requests/second with a burst of 10. Combined with
  `maxTokens` 400 and `maxPromptLength` 2000, this bounds worst-case spend. Note there is
  no per-principal quota and the stack does not provision an AWS Budgets alarm —
  configure one at the account level if leaving the stack deployed.

## 7. Supply chain

- `package-lock.json` is committed; CI uses `npm ci`, so builds are reproducible.
- `.github/dependabot.yml` groups npm updates weekly and GitHub Actions monthly.
- The Lambda bundle pins the AWS SDK version from the lock file rather than inheriting
  whatever version the Lambda runtime image carries.
- **Production dependency audit is clean** (`npm audit --omit=dev` reports no
  vulnerabilities for the runtime tree, modulo the item below).
- **Known unfixed advisories, dev/build tooling only.** `npm audit` reports DoS-class
  advisories in `brace-expansion` and `sprintf-js`, reached transitively through Jest,
  ESLint and the CDK CLI's bundled `minimatch`. No patched version was available at the
  time of writing — the CDK CLI copy is vendored inside `aws-cdk-lib` and cannot be
  reached by an npm `overrides` entry. These packages run only during local development,
  testing and synthesis; none is present in the deployed Lambda bundle. CI therefore does
  not gate on `npm audit`, because a gate configured to ignore the only findings it
  produces would be a false signal. Dependabot will raise the update when upstream
  publishes one.

## 8. CI/CD security

**No AWS credentials are stored in this repository.**

`validate.yml` needs no AWS access at all: `cdk synth` runs with placeholder
account/region values. Its token has `contents: read` only.

`deploy.yml` is `workflow_dispatch` only, requires the literal confirmation string
`deploy`, re-runs lint/type-check/tests before deploying, and authenticates with **GitHub
OIDC** — a short-lived token exchanged for AWS credentials, with no long-lived access key
anywhere. It holds `id-token: write` and `contents: read`.

### 8.1 Required one-time AWS setup

1. Create (or reuse) the GitHub OIDC identity provider in the account:

   - Provider URL: `https://token.actions.githubusercontent.com`
   - Audience: `sts.amazonaws.com`

2. Create a deployment role with this trust policy, scoped to this repository — the
   `sub` condition is what prevents another repository from assuming it:

   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       {
         "Effect": "Allow",
         "Principal": {
           "Federated": "arn:aws:iam::<ACCOUNT_ID>:oidc-provider/token.actions.githubusercontent.com"
         },
         "Action": "sts:AssumeRoleWithWebIdentity",
         "Condition": {
           "StringEquals": {
             "token.actions.githubusercontent.com:aud": "sts.amazonaws.com"
           },
           "StringLike": {
             "token.actions.githubusercontent.com:sub": "repo:<OWNER>/43030-aws-serverless-genai:*"
           }
         }
       }
     ]
   }
   ```

   Narrow the `sub` further for stricter control, for example
   `repo:<OWNER>/43030-aws-serverless-genai:ref:refs/heads/main`.

3. Attach deployment permissions. The simplest correct option for a CDK v2 project is to
   allow `sts:AssumeRole` on the CDK bootstrap roles
   (`arn:aws:iam::<ACCOUNT_ID>:role/cdk-*`), so the role itself holds no broad
   infrastructure permissions and CDK's own scoped bootstrap roles do the work.

4. Set the **repository variable** (not a secret — a role ARN is not sensitive, though it
   does contain the account id, so a secret is also acceptable):
   `AWS_DEPLOY_ROLE_ARN = arn:aws:iam::<ACCOUNT_ID>:role/<role-name>`

5. Optionally configure a GitHub **Environment** matching `environment_name` with required
   reviewers, so a deployment needs human approval.

## 9. Account-level side effect to review before deploying

API Gateway stage logging requires an **account-wide** API Gateway CloudWatch Logs role.
The stack sets `cloudWatchRole: true`, so CDK creates that role and sets the account
setting (`AWS::ApiGateway::Account`), with `RemovalPolicy.DESTROY`.

In a personal learning account this is harmless and is what makes the API access-log and
execution-log evidence possible. **In a shared account that already has this setting
configured, deploying will overwrite it, and destroying the stack may remove it**,
affecting other APIs in the same account and region. If that applies to you, either
deploy into an isolated account, or set `cloudWatchRole: false` in
`lib/serverless-genai-stack.ts` and remove the `loggingLevel` / `accessLogDestination`
options from `deployOptions`.

## 10. Verification

What is machine-verified, and by what:

| Claim | Verified by |
| --- | --- |
| Both methods require IAM authorisation | `test/infrastructure.test.ts` — asserts `AuthorizationType: AWS_IAM` on all methods |
| Only two DynamoDB actions exist in the whole template | `test/infrastructure.test.ts` — full action-set equality |
| Bedrock is scoped to the configured model, never `*` | `test/infrastructure.test.ts` |
| No Bedrock permission exists in mock mode | `test/infrastructure.test.ts` |
| Request body is schema-validated at the edge | `test/infrastructure.test.ts` — validator + model schema assertions |
| Table is encrypted, TTL-enabled, on-demand | `test/infrastructure.test.ts` |
| No expensive/always-on resource types are present | `test/infrastructure.test.ts` — count-zero assertions for EC2/VPC/NAT/RDS/ALB/OpenSearch/ECS |
| Error responses contain no internal detail | `test/observability.test.ts`, handler tests |
| Prompt text never appears in any log line | `test/generate-handler.test.ts` — asserts a unique phrase is absent from every emitted line |
| Prompt text is never persisted | `test/repository.test.ts`, `test/generate-handler.test.ts` |
| Internal attributes are not returned by the GET endpoint | `test/get-request-handler.test.ts` |
| Invalid path parameters never reach DynamoDB | `test/get-request-handler.test.ts` |

Live-deployment verification status is recorded in `docs/evaluation.md`; anything not
exercised against real AWS is labelled there rather than implied here.
