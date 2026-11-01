# Local Validation Guide

How to reproduce every test in this repository **without an AWS account, without AWS
credentials, and without any cost** — including the local integration/security suite
added to extend the existing 155 mocked tests. This guide is itself part of the UTS A3
Goal 4 evidence: it documents a real, repeatable, zero-cost verification path.

## What "local" means here, precisely

| Layer | How it's exercised locally | Real service ever touched? |
|---|---|---|
| Lambda handler code | Invoked directly, in-process (no SAM/LocalStack emulation of API Gateway → Lambda invocation) | No |
| Amazon Bedrock | `MOCK_BEDROCK=true` (existing `MockGenerationClient`, see `src/shared/bedrock.ts`) for most tests; `aws-sdk-client-mock` on `BedrockRuntimeClient` for the handful of tests that need a specific response shape (guardrail block, timeout) | **Never** |
| Amazon DynamoDB | Real `amazon/dynamodb-local` Docker container, or `aws-sdk-client-mock` (existing 155 tests) | **Never** (DynamoDB Local is a separate, real DynamoDB-API-compatible engine AWS publishes specifically for this purpose) |
| AWS CDK / CloudFormation | `cdk synth` with `CDK_DEFAULT_ACCOUNT=000000000000`, a dummy account id that can never resolve to a real account | **Never** |

## One-time setup

```bash
npm ci
```

## Running everything

```bash
npm run lint
npm run typecheck
npm test                 # all 155 existing tests + the new local suite = 173 (2 of those are
                          # intentional documentation skips -- see "Known limitations" below)
CDK_DEFAULT_ACCOUNT=000000000000 CDK_DEFAULT_REGION=ap-southeast-2 npx cdk synth --quiet
npm run evaluate:mock
```

## Running the new local-DynamoDB suite specifically

```bash
npm run dynamodb:local:up     # docker run amazon/dynamodb-local, in-memory, port 8000
npm run test:local            # test/local-integration.test.ts + test/local-security.test.ts
npm run dynamodb:local:down   # stop the container
```

If DynamoDB Local is not running, `npm run test:local` does not fail or hang — every test
in both files is wrapped in `describe.skip`/`it.skip` with the reason printed in the test
output (see `test/local-dynamodb-helper.ts`'s `isDynamoDbLocalReachable()`, a synchronous
`curl` probe checked once before Jest registers any test). This mirrors the same
"skip with a reason, never silently pass" pattern already used for live-cluster tests in
the companion `k8s-production-lab` repository's `tests/security/conftest.py`.

## Why DynamoDB Local, specifically, and not just more mocking

The existing 155 tests (`test/generate-handler.test.ts` etc.) mock `DynamoDBDocumentClient`
with `aws-sdk-client-mock` — which proves the application code *calls* DynamoDB correctly
in the sense of "produces a `PutCommand` with the fields I expect," but a mock that
always resolves `{}` when told to can never catch a malformed request that a *real*
DynamoDB implementation would reject. `test/local-integration.test.ts` and
`test/local-security.test.ts` close that specific gap: they run the exact same handler
code against a real DynamoDB-compatible engine, so the `ConditionExpression`, attribute
marshalling, and error types (`ResourceNotFoundException`) are proven against real
DynamoDB API behaviour, not an obedient mock.

## Safety design — how an accidental real-AWS call is prevented, not just discouraged

`src/shared/repository.ts`'s `getRepository()` constructs `new DynamoDBClient({})` with
no explicit endpoint — meaning the AWS SDK's own environment-variable resolution is the
**only** thing standing between a test and a real AWS call. `test/local-dynamodb-helper.ts`'s
`configureLocalAwsEnvironment()` sets, before any handler is invoked:

- `AWS_ENDPOINT_URL_DYNAMODB` and the generic `AWS_ENDPOINT_URL` (both pointed at
  `http://localhost:8000`) — the AWS SDK v3 honours these natively; verified empirically
  in this review (`ListTables` against the local container succeeded with no other
  configuration).
- `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` set to obvious fake values — so that *if*
  the endpoint override were somehow bypassed, a real AWS call would fail authentication
  immediately (`UnrecognizedClientException`) rather than risk succeeding.
- `AWS_EC2_METADATA_DISABLED=true` — prevents any IMDS-based credential escalation.
- `MOCK_BEDROCK=true` by default for every test except the two that specifically need a
  mocked Bedrock *response shape* (guardrail block, timeout) — which still never make a
  real network call, since `BedrockRuntimeClient` itself is intercepted by
  `aws-sdk-client-mock` in those cases.

On top of the environment guard, every test file's reachability probe
(`isDynamoDbLocalReachable()`) means that if local DynamoDB isn't up, the suite skips
rather than hangs trying to reach something — so a misconfigured environment fails safe
(skipped tests, visible in the report) instead of failing open (a slow, expensive attempt
to reach real infrastructure).

**One real pitfall found and fixed during this review**: DynamoDB Local performs genuine
SigV4 signature validation, not a no-op. An access-key-id value containing hyphens (the
first attempt used `local-fake-access-key-id`) breaks SigV4 credential-scope parsing and
is rejected with `UnrecognizedClientException` — a real DynamoDB Local behaviour, not a
bug in this project's code. Fixed by using a plain alphanumeric fake value
(`LOCALFAKEACCESSKEY0`). Documented here so it doesn't have to be rediscovered.

## If Docker is not available

This review had Docker available (`amazon/dynamodb-local` pulled and run with
`-sharedDb -inMemory`, zero disk persistence, container removed with `--rm`). If it isn't
available in your environment, the fallback is: **run `npm test` without
`npm run test:local`**. This still gives:

- All 155 existing tests (fully mocked Bedrock + DynamoDB) — `IMPLEMENTED`/`MOCK VERIFIED`
  coverage of every application-logic path.
- `npm run evaluate:mock` — the same mock-mode evaluation coverage.
- `cdk synth` — the same infrastructure-template verification.

What you lose without Docker: the specific guarantees that `test/local-integration.test.ts`
and `test/local-security.test.ts` add over the mocked suite — real `ConditionExpression`
enforcement, real `ResourceNotFoundException` behaviour, and proof that the DynamoDB wire
calls are well-formed against an actual DynamoDB API implementation rather than an
always-obedient mock. That gap should be stated as `NOT VERIFIED` (not glossed over) if
Docker is unavailable when this is reproduced elsewhere.

## Known limitations (do not overclaim these)

- No real Bedrock call is ever made by anything in this guide. "Verified" in this
  document never means "verified against the real model or the real Guardrail decision."
- DynamoDB Local does not meter read/write capacity and does not implement every
  DynamoDB feature (Global Tables, DAX) — immaterial to this project's single-table,
  no-GSI schema, but worth knowing.
- See `docs/local-evaluation-report.md` for the full Pass/Fail/Skip breakdown and
  `docs/uts-a3-goal4-evidence.md` for how this maps onto the A1 Goal 4 requirements.
