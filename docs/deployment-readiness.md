# Deployment Readiness Checklist

Pre-deployment checklist for turning this project's **code-complete, tested, synthesised**
state into a **deployed, live-verified** one. This document does not deploy anything —
it states what is required, what was verified in this review, and what still blocks a
real `cdk deploy`. See `docs/evidence-guide.md` for what to capture once deployed, and
`docs/evaluation.md` §4.2 for why no live evaluation results exist yet.

## 1. Required AWS IAM permissions

Two separate principals need permissions, for two separate purposes:

**A. The deploying principal** (you, locally, or the GitHub Actions OIDC role) needs
permission to create every resource type listed in `docs/architecture.md` §4 plus
`cloudformation:*` for the stack itself and `iam:CreateRole`/`iam:PutRolePolicy` to create
the Lambda execution roles. In practice this means `AdministratorAccess` or an
equivalent broad deployment role in a sandbox/learner account — this project does not
ship a minimal "deployer" policy, because CDK deployment permissions are inherently
broad (CloudFormation needs to create IAM roles on your behalf).

**B. The deployed Lambda execution roles** (what actually runs in production) are
already least-privilege and defined entirely in code — see `lib/serverless-genai-stack.ts`
IAM grants and `lib/bedrock-permissions.ts`. Nothing to configure manually; this is the
part already verified in this review (§3 below).

## 2. AWS account / region prerequisites

- An AWS account with a **valid, active** credential (IAM user access key, SSO session, or
  an assumable role) — see §6 "Current blocker" below; this is the actual gap found in
  this review.
- Target region: `ap-southeast-2` (default; any Bedrock-enabled region works via
  `-c awsRegion=...` / `CDK_DEFAULT_REGION`).
- `cdk bootstrap` run once per account/region (§4).
- Sufficient service quotas for API Gateway, Lambda, DynamoDB, and CloudWatch at default
  levels — this project's footprint (2 Lambdas, 1 table, 1 REST API, 1 dashboard, 2 alarms)
  is far below default quotas in any account that has never been throttled before.

## 3. Bedrock model availability

- Default model: `apac.amazon.nova-micro-v1:0` (cross-region inference profile,
  Asia-Pacific geography) — see `docs/architecture.md` §4 and README.md §11.
- **Model access must be explicitly enabled** in the Bedrock console (Model access page)
  for the account/region before first invocation — this is an AWS-side opt-in separate
  from IAM permissions, and this review could not verify whether it has been enabled on
  the account in question (requires console access, not inspectable from this repo).
- Verify with (read-only, no state change):
  ```bash
  aws bedrock list-foundation-models --query 'modelSummaries[?outputModalities[0]==`TEXT`].[modelId,modelName]' --output table
  aws bedrock list-inference-profiles --query 'inferenceProfileSummaries[].inferenceProfileId' --output table
  ```
- **Fallback if Bedrock access is unavailable**: deploy with `-c mockBedrock=true`
  (README.md §11) — every other layer (API Gateway, Lambda, DynamoDB, CloudWatch, X-Ray,
  validation, persistence) still deploys and is still live-verifiable; only the
  model-output-quality evidence (E8, relevance/format dimensions) would remain mock-only.

## 4. Bedrock Guardrails requirements

- `enableGuardrail: true` by default (`cdk.json` context) — the stack creates a
  `AWS::Bedrock::Guardrail` + `AWS::Bedrock::GuardrailVersion` resource itself (confirmed
  by `cdk synth`, see §7 below); no manual console setup is required, this is IaC-managed.
- Requires `bedrock:CreateGuardrail` permission for the deploying principal (README.md §9)
  — covered by the broad deployment permissions in §1A, not a separate grant.
- **If the account cannot create guardrails** (e.g. a locked-down organisation policy):
  deploy with `-c enableGuardrail=false`; application-level validation (regex-based
  prompt-injection/sensitive-data flagging in `src/shared/validation.ts`) is unaffected —
  only the Bedrock-side content-filter layer is skipped.

## 5. CDK bootstrap requirements

```bash
aws sts get-caller-identity   # confirm the credential resolves BEFORE bootstrapping
npx cdk bootstrap
```

One-time per account/region. Creates the CDK staging bucket and the deployment roles CDK
uses internally (`CDKToolkit` stack). Not yet run against a real account in this review —
blocked on §6.

## 6. Current blocker — diagnosed in this review

`docs/evaluation.md` §4.2 already states the stack has never been deployed because of an
`InvalidClientTokenId` error. This review reproduced and localised that error without
touching any credential file:

```
$ aws sts get-caller-identity
An error occurred (InvalidClientTokenId) when calling the GetCallerIdentity operation:
The security token included in the request is invalid.
```

**Diagnosis**: `InvalidClientTokenId` specifically means the *access key id itself* is not
recognised by AWS IAM — distinct from `ExpiredToken` (a session token past its expiry) or
`AccessDenied` (a valid identity lacking permission). No `AWS_ACCESS_KEY_ID`/
`AWS_SECRET_ACCESS_KEY` environment variables are set in this shell, so the credential
being rejected is the one stored in `~/.aws/credentials` under the `[default]` profile.
An invalid-access-key-id error for a profile that exists almost always means one of:

1. The IAM access key was deleted or deactivated in the AWS console after being saved
   locally, or
2. The key was never a real key (a placeholder/typo was saved), or
3. The credential belongs to an AWS Educate/Academy/sandbox account whose keys rotate or
   expire on a schedule (common for university-provided sandboxes).

**This review did not and will not inspect, print, or modify the contents of
`~/.aws/credentials` or `~/.aws/config`** — per the task's explicit instruction, fixing
this requires you to either regenerate an IAM access key in the AWS console (or run
`aws configure` / `aws sso login` yourself) and confirm independently with
`aws sts get-caller-identity` before any `cdk bootstrap`/`cdk deploy` is attempted.

## 7. What was verified in this review (no AWS calls made)

| Check | Result |
|---|---|
| `npm ci` | 458 packages installed from lockfile |
| `npm run lint` | clean |
| `npm run typecheck` | clean |
| `npm test` | **155/155 tests passed, 8 suites** — matches the README/evidence-guide claim exactly |
| `npm audit` (production dependencies only) | 1 high-severity finding (`brace-expansion`, transitive via `aws-cdk-lib`) — **fixed** via `npm audit fix` (lockfile-only change, no breaking version bump); 1 moderate finding (`minimatch`, bundled inside `aws-cdk-lib` itself) — **no fix available upstream**, consistent with `docs/security.md` §1 T12's own disclosure of "known dev-tooling advisories with no published fix." This dependency is CDK/CLI tooling only — confirmed by `grep -rl aws-cdk-lib src/` returning no results, i.e. it is never bundled into deployed Lambda code. |
| `CDK_DEFAULT_ACCOUNT=000000000000 CDK_DEFAULT_REGION=ap-southeast-2 npx cdk synth --quiet` | **Succeeded**, no AWS credentials used (dummy account/region, standard CDK offline-synth pattern). Produced a real CloudFormation template: 2 `AWS::Lambda::Function`, 1 `AWS::DynamoDB::Table`, 1 `AWS::ApiGateway::RestApi` + 2 methods, 1 `AWS::Bedrock::Guardrail` + 1 `GuardrailVersion`, 2 `AWS::CloudWatch::Alarm`, 1 `AWS::CloudWatch::Dashboard`, 3 `AWS::IAM::Role`, 2 `AWS::IAM::Policy`, 1 `AWS::SNS::Topic` (alarm notifications). |
| `npm run evaluate:mock` | 13/13 cases ran, 20 dimension checks passed, 0 failed, 16 skipped (skips are all mock-mode-only dimensions: relevance, format, latency — expected and correctly labelled, not hidden). See `docs/uts-a3-goal4-evidence.md` for the full dimension-coverage analysis, including which named dimensions (groundedness, guardrail-behaviour) are not yet exercised even in mock mode. |
| `aws sts get-caller-identity` | **Failed — `InvalidClientTokenId`** (diagnosed above) |
| `cdk bootstrap` / `cdk deploy` | **Not attempted** — explicitly out of scope for this review, and blocked on §6 regardless |

## 8. Estimated cost and cost controls

Already documented in README.md §15 in full; summary for a go/no-go decision:

- Everything is serverless/on-demand — idle cost ≈ $0.
- `docs/evidence-guide.md`'s suggested capture sequence needs roughly 12 live Bedrock
  invocations (3 manual + 8 evaluation + 1 spare) on Nova Micro — "well under one cent."
- Stage throttling (5 rps / burst 10), `maxTokens` 400, 7-day log retention, and
  DynamoDB on-demand + TTL all bound worst-case spend even under misuse.
- Realistic exposure for a deploy → capture evidence → destroy cycle: **cents, not
  dollars**.

## 9. Deployment commands (for your reference — not run in this review)

```bash
aws sts get-caller-identity              # MUST succeed before proceeding
npx cdk bootstrap                        # one-time per account/region
npx cdk diff                             # review the change set
npx cdk deploy --outputs-file cdk-outputs.json
```

## 10. Rollback / cleanup commands

```bash
npx cdk destroy
# Verify:
aws cloudformation describe-stacks --stack-name ServerlessGenAi-dev   # should error "does not exist"
aws dynamodb list-tables                                               # table should be gone
```

Full detail, including the one account-level side effect (API Gateway's account-wide
CloudWatch Logs role) worth knowing before deploying into a **shared** account: README.md
§16.

## 11. Post-deployment verification

In order, so each step produces what the next needs (same sequence as
`docs/evidence-guide.md` §"Suggested capture order"):

1. `aws cloudformation describe-stacks --stack-name ServerlessGenAi-dev` → `CREATE_COMPLETE`
2. Negative test first: unsigned `curl` to `/generate` → expect `403 Missing Authentication Token`
3. Signed `curl` call → expect `200` with `"mode": "live"` in the response metadata
4. Retrieval round trip: `GET /requests/{requestId}` for the same id → expect `200`
5. CloudWatch Logs Insights query for the same `requestId` → confirm structured log entry,
   and separately confirm a **zero-result** search for the actual prompt text (proves
   prompts are not logged)
6. `npm run evaluate -- --mode live --api "$API_BASE_URL"` → generates
   `evidence/evaluation-live.md`
7. `npx cdk destroy` once evidence is captured, if not keeping the stack running

## 12. Evidence collection checklist

Do not re-derive this — `docs/evidence-guide.md` is the authoritative, already-written
15-item (E1–E15) checklist with capture commands, redaction rules, and "why it matters"
for each item. This document's job is only to confirm *you are ready to deploy*; once
deployed, follow `docs/evidence-guide.md` directly.
