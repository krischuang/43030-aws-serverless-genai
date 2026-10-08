# Portfolio evidence guide

What to capture for **UTS 43030 Professional Practice in Computing, Assessment 3**, for
the learning goal *"Build and evaluate a secure AWS serverless generative AI
application."*

Fifteen items, E1–E15. Each states what to capture, why it demonstrates professional
capability, and which part of the learning goal it supports. Items marked **[no
deployment needed]** can be captured right now; items marked **[requires deployment]**
need the stack running.

**Before you capture anything, read §0.**

---

## 0. Capture rules

1. **Redact the AWS account id** — it appears in ARNs, the console header, role names and
   CloudFormation stack ids. Blur or crop it in every screenshot.
2. **Redact the API Gateway host** (`abc123xyz.execute-api.<region>.amazonaws.com`) in any
   image you will submit publicly. Keep the path visible — `/dev/generate` is the
   interesting part.
3. **Never include credentials** — access keys, session tokens, or a terminal that has
   just printed them.
4. **Do not manufacture evidence.** If something was not deployed or not run, say so.
   `docs/evaluation.md` §4.2 is the model for how to record a gap honestly, and a marker
   reads an acknowledged gap far better than a fabricated success.
5. **Prefer text output over screenshots where both work** — CLI output pastes into a
   report cleanly and is easier to redact. Screenshots are for console UI that proves a
   resource genuinely exists.
6. **Keep raw captures in `evidence/`**, which is git-ignored. Do not commit
   account-specific output.
7. **Date every capture.** A marker needs to see that evidence and commits are
   contemporaneous.

---

## E1 — Architecture diagram

**[no deployment needed]**

**Capture.** The rendered Mermaid diagram from `README.md` §3. View it on GitHub (which
renders Mermaid natively) and screenshot it, or export from the Mermaid live editor.
Alongside it, capture the request-lifecycle block from `docs/architecture.md` §3, which
shows every failure branch and its status code.

**Why it demonstrates capability.** An architecture diagram that names the actual
constructs, the authorisation mechanism and the failure paths — rather than three generic
boxes — shows you can reason about a system as a whole: trust boundaries, data flow, and
what happens when each hop fails.

**Supports.** *Build* — the overall design of a secure serverless AI application.

---

## E2 — CDK source code (Infrastructure as Code)

**[no deployment needed]**

**Capture.** Three excerpts, not the whole file:

1. `lib/serverless-genai-stack.ts` — the DynamoDB table block (billing mode, encryption,
   TTL, removal policy) with its explanatory comment.
2. The IAM section: `table.grant(generateFunction, 'dynamodb:PutItem')`,
   `table.grant(getRequestFunction, 'dynamodb:GetItem')`, and the two scoped Bedrock
   `PolicyStatement`s.
3. `lib/bedrock-permissions.ts` in full — it is short, and the inference-profile-vs-
   foundation-model distinction is the most technically interesting decision in the repo.

Also capture `lib/stack-config.ts` or the `cdk.json` context block, to show configuration
is externalised rather than hard-coded.

**Why it demonstrates capability.** It shows infrastructure expressed as reviewable,
version-controlled, testable code, with least privilege written as a deliberate choice
(single actions, not `grantReadWriteData`) rather than a convenient default.

**Supports.** *Build* — Infrastructure as Code and least-privilege IAM.

---

## E3 — `cdk synth` success

**[no deployment needed]**

**Capture.** Terminal output of:

```bash
npx cdk synth --quiet && echo "SYNTH OK"
```

Then show that the template is real:

```bash
CDK_DEFAULT_ACCOUNT=000000000000 CDK_DEFAULT_REGION=ap-southeast-2 npx cdk synth --quiet
node -e "const t=require('./cdk.out/ServerlessGenAi-dev.template.json');const c={};for(const r of Object.values(t.Resources))c[r.Type]=(c[r.Type]||0)+1;console.log(Object.entries(c).sort().map(([k,v])=>k+' x'+v).join('\n'))"
```

**Why it demonstrates capability.** Synthesis proves the IaC is valid CloudFormation
*before* any deployment and without credentials — the cheap, fast feedback loop that
separates IaC practice from click-ops. The resource inventory shows breadth at a glance.

**Supports.** *Build* — reproducible deployment, IaC.

---

## E4 — Deployed CloudFormation stack

**[requires deployment]**

**Capture.** Both of:

- CloudFormation console → stack `ServerlessGenAi-dev` → **Resources** tab, showing the
  full resource list with `CREATE_COMPLETE`.
- The **Outputs** tab.

Or as text:

```bash
aws cloudformation describe-stacks --stack-name ServerlessGenAi-dev \
  --query 'Stacks[0].{Status:StackStatus,Created:CreationTime}'
aws cloudformation describe-stack-resources --stack-name ServerlessGenAi-dev \
  --query 'StackResources[].{Type:ResourceType,Status:ResourceStatus}' --output table
```

**Why it demonstrates capability.** Closes the loop between declared and actual
infrastructure: every resource in the diagram exists, created from code, in one
operation.

**Supports.** *Build* — reproducible deployment.

---

## E5 — API Gateway

**[requires deployment]**

**Capture.** Three screenshots:

1. **Resources** view showing `/generate` (POST) and `/requests/{requestId}` (GET).
2. The POST method's **Method Request** panel, showing **Authorization: AWS_IAM**, the
   request validator, and the `GenerateRequest` model. This is the single best screenshot
   in the set for the word "secure".
3. **Stages → dev → Logs/Tracing**, showing X-Ray enabled, CloudWatch logging, metrics
   enabled, throttling at 5/10, and **Data trace disabled**.

Pair it with a negative test — proof the endpoint is not open:

```bash
curl -i -X POST "${API}generate" -H 'content-type: application/json' \
  -d '{"prompt":"hello there"}'
# expect HTTP/2 403 with {"message":"Missing Authentication Token"}
```

**Why it demonstrates capability.** Shows authorisation, validation and throttling
configured at the edge, and the unsigned-request rejection proves the control is live
rather than merely declared. The disabled data trace shows awareness that verbose logging
is itself a data-protection risk.

**Supports.** *Build* — API security. *Evaluate* — verifying a control works.

---

## E6 — Lambda

**[requires deployment]**

**Capture.** For the generate function:

1. The function **Configuration → General** panel: runtime `nodejs22.x`, architecture
   `arm64`, memory 512 MB, timeout 30 s.
2. **Configuration → Environment variables**, showing externalised configuration
   (`BEDROCK_MODEL_ID`, `MAX_PROMPT_LENGTH`, `GUARDRAIL_ID`, …) **and no secrets**.
3. **Configuration → Permissions → Resource summary**, expanding the Bedrock and DynamoDB
   entries to show the scoped actions.

Or as text:

```bash
FN=$(aws cloudformation describe-stacks --stack-name ServerlessGenAi-dev \
  --query "Stacks[0].Outputs[?OutputKey=='GenerateFunctionName'].OutputValue" --output text)
aws lambda get-function-configuration --function-name "$FN" \
  --query '{Runtime:Runtime,Arch:Architectures,Memory:MemorySize,Timeout:Timeout,Tracing:TracingConfig}'
```

**Why it demonstrates capability.** The environment-variable panel is direct evidence of
configuration/code separation and of no-hard-coded-secrets. The permissions summary is
direct evidence of least privilege as deployed, not just as written.

**Supports.** *Build* — Lambda, least-privilege IAM, no hard-coded secrets.

---

## E7 — DynamoDB

**[requires deployment]**

**Capture.** Three things:

1. Table **Overview**: partition key `requestId`, capacity mode **On-demand**,
   encryption, and **Time to live: Enabled (ttl)**.
2. **Explore items** after making a live call — one record.
3. The record expanded, to show what is stored: `requestId`, `createdAt`, `status`,
   `modelId`, `responseText`, `promptLength`, `promptFingerprint`, `safetyFlags`,
   `inputTokens`, `outputTokens`, `latencyMs`, `ttl` — and **no `prompt` attribute**.

Or as text:

```bash
TABLE=$(aws cloudformation describe-stacks --stack-name ServerlessGenAi-dev \
  --query "Stacks[0].Outputs[?OutputKey=='RequestTableName'].OutputValue" --output text)
aws dynamodb describe-table --table-name "$TABLE" \
  --query 'Table.{Keys:KeySchema,Billing:BillingModeSummary.BillingMode,SSE:SSEDescription.Status}'
aws dynamodb describe-time-to-live --table-name "$TABLE"
aws dynamodb scan --table-name "$TABLE" --max-items 1
```

**Why it demonstrates capability.** Item 3 is the strongest data-protection evidence in
the project: a visible design decision to store a hash and a length instead of user text.
Pair the screenshot with the comment at the top of `src/shared/repository.ts` that
explains why.

**Supports.** *Build* — DynamoDB, data minimisation, encryption at rest.

---

## E8 — Bedrock response

**[requires deployment]**

**Capture.** A successful live call and its response:

```bash
curl -sS "${API}generate" \
  --aws-sigv4 "aws:amz:${REGION}:execute-api" \
  --user "$AWS_ACCESS_KEY_ID:$AWS_SECRET_ACCESS_KEY" \
  -H "x-amz-security-token: $AWS_SESSION_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"prompt":"Explain serverless computing in one paragraph."}' | tee evidence/e8-generate.json
```

Then the retrieval round trip for the same `requestId`, proving persistence end to end.
Also capture the Bedrock console **Model access** page showing the model is enabled, and
note the model id from the stack output.

**Critical:** the response must show `"mode": "live"`. If it shows `"mode": "mock"`, it is
**not** Bedrock evidence — label it as mock-mode output and keep it separate.

**Why it demonstrates capability.** Shows a working generative AI integration with
useful metadata — token counts, stop reason, latency — rather than just a block of text,
which is what distinguishes an engineered integration from a demo script.

**Supports.** *Build* — Amazon Bedrock integration. *Evaluate* — observable model
behaviour.

---

## E9 — CloudWatch structured logs

**[requires deployment]**

**Capture.** Logs Insights, not the raw log stream. Run this query against the generate
function's log group:

```
fields @timestamp, operation, status, durationMs, modelLatencyMs, inputTokens, outputTokens, stopReason, promptFingerprint
| filter service = "serverless-genai"
| sort @timestamp desc
| limit 20
```

Capture the results table, then expand one `request completed` entry to show the full JSON
object with `requestId` and `correlationId`.

Then make a deliberately invalid call and capture the error line:

```bash
curl -sS "${API}generate" --aws-sigv4 "aws:amz:${REGION}:execute-api" \
  --user "$AWS_ACCESS_KEY_ID:$AWS_SECRET_ACCESS_KEY" \
  -H "x-amz-security-token: $AWS_SESSION_TOKEN" \
  -H 'content-type: application/json' -d '{"prompt":""}'
```

```
fields @timestamp, status, errorCategory, errorCode, statusCode
| filter status = "failed"
| sort @timestamp desc
```

**The most valuable capture here is a negative one:** search the log group for a distinctive
word from your prompt and show **zero results**, proving prompt text is genuinely absent
from logs.

```
fields @message | filter @message like /distinctive-word-from-your-prompt/
```

**Why it demonstrates capability.** Queryable JSON logs with correlation ids and an error
taxonomy are what make a system operable. The zero-result search turns "we don't log
prompts" from a claim into verified evidence.

**Supports.** *Build* — CloudWatch logging, log sanitisation. *Evaluate* — operational
visibility.

---

## E10 — CloudWatch metrics, alarms, tracing

**[requires deployment]**

**Capture.** Four things:

1. The dashboard `43030-ServerlessGenAI-dev` after a few calls — API count/errors, API
   latency percentiles, Lambda invocations/errors, duration percentiles, DynamoDB
   capacity.
2. The **Alarms** list showing both alarms and their states (`OK` is a valid, good
   result — pair it with the alarm's configuration panel showing the threshold).
3. An **X-Ray trace map** showing API Gateway → Lambda.
4. One **trace detail** view with the segment timeline.

For the alarm, capture the configuration too:

```bash
aws cloudwatch describe-alarms --alarm-name-prefix 43030-ServerlessGenAI-dev \
  --query 'MetricAlarms[].{Name:AlarmName,Metric:MetricName,Threshold:Threshold,State:StateValue}' --output table
```

**Honesty note for your write-up:** the trace shows API→Lambda but *not* Bedrock or
DynamoDB subsegments, because the AWS SDK is not instrumented with the X-Ray SDK. Say so
and point to `docs/architecture.md` §2.10. Stating a known limitation alongside working
evidence reads as engineering judgement; letting a marker discover it reads as an
oversight.

**Supports.** *Build* — metrics, alarms, tracing. *Evaluate* — monitoring a live system.

---

## E11 — Automated tests

**[no deployment needed]**

**Capture.**

```bash
npm test 2>&1 | tail -15
```

Showing **8 suites, 155 tests passing**. Then capture excerpts that show the tests are
meaningful rather than trivial:

1. From `test/infrastructure.test.ts` — the IAM suite, especially
   `'never grants a DynamoDB wildcard action'` and
   `'scopes bedrock:InvokeModel to the configured model and inference profile'`.
2. From `test/generate-handler.test.ts` —
   `'emits structured JSON logs that never contain the prompt text'`.
3. From `test/bedrock.test.ts` —
   `'classifies an access-denied failure as a configuration fault without leaking it'`.

Optionally `npm run test:coverage` for a coverage summary.

**Why it demonstrates capability.** Asserting on the *synthesised CloudFormation template*
shows infrastructure treated as testable code — a notably more mature practice than unit
tests alone. The three named tests show security properties encoded as executable
assertions, so a future change that weakens them fails CI.

**Supports.** *Build* — automated testing. *Evaluate* — verification discipline.

---

## E12 — GitHub Actions CI/CD

**[no deployment needed]**

**Capture.**

1. The **Actions** tab showing green `validate` runs across several commits.
2. One run expanded, showing all steps: install → lint → type-check → test → cdk synth →
   mock evaluation.
3. The uploaded `evaluation-report-mock` artifact on that run.
4. `.github/workflows/deploy.yml` — the `workflow_dispatch`-only trigger, the `confirm`
   input, and the `permissions: id-token: write` OIDC block.

**Why it demonstrates capability.** Automatic validation plus *deliberately manual*
deployment shows you understand that continuous delivery of a cost-incurring AI endpoint
is a risk decision, not a default. The OIDC block shows credential-free CI rather than
long-lived access keys in secrets — pair it with `docs/security.md` §8.1.

**Supports.** *Build* — CI/CD. *Evaluate* — repeatable verification.

---

## E13 — Evaluation result

**[mock: no deployment needed] [live: requires deployment]**

**Capture.**

```bash
npm run evaluate:mock
```

Capture the terminal summary and the generated `evidence/evaluation-mock.md` — the
dimension totals table and the per-case matrix.

Then, if deployed:

```bash
npm run evaluate -- --mode live --api "$API_BASE_URL"
```

Capture `evidence/evaluation-live.md`, and in your write-up contrast the two: which
dimensions moved from `skipped` to a real verdict, and what the live run revealed that
the mock run could not.

**Label every figure with its mode.** Mock results are not model evidence. The report
header says so; keep that header in the capture.

**Why it demonstrates capability.** This is the single strongest *Evaluate* artefact.
A 13-case suite scored across five dimensions, with a `skipped` verdict for anything the
current mode cannot honestly judge, demonstrates systematic evaluation — and the
`skipped` design is itself worth a paragraph in the report, because it shows you
considered how an evaluation harness can mislead.

**Supports.** *Evaluate* — the entire second half of the learning goal.

---

## E14 — Git history showing incremental development

**[no deployment needed]**

**Capture.**

```bash
git log --oneline --decorate --graph --all
git log --stat --oneline | head -60
```

Show the shape of the work: a bootstrap commit on `main`, feature work on
`feature/serverless-genai-portfolio` in small Conventional Commits
(`chore:`, `feat(infra):`, `feat(api):`, `feat(data):`, `feat(observability):`, `test:`,
`ci:`, `docs:`), then a non-fast-forward merge commit back to `main` that preserves the
branch topology.

Also capture one `git show --stat <hash>` for a single focused commit.

**Why it demonstrates capability.** Conventional Commits and a preserved merge topology
show professional version-control practice: work is traceable, each commit has one
purpose, and history was not rewritten to look tidier than it was. The `--no-ff` merge
specifically preserves evidence that the work happened on a branch.

**Supports.** Professional practice — the discipline dimension of the subject.

---

## E15 — Security and IAM configuration

**[partly no deployment needed]**

**Capture.** The strongest security evidence is the *synthesised policy*, which needs no
deployment:

```bash
CDK_DEFAULT_ACCOUNT=000000000000 CDK_DEFAULT_REGION=ap-southeast-2 npx cdk synth --quiet
node -e "const t=require('./cdk.out/ServerlessGenAi-dev.template.json');for(const [k,v] of Object.entries(t.Resources)){if(v.Type==='AWS::IAM::Policy'){console.log('##',k);console.log(JSON.stringify(v.Properties.PolicyDocument.Statement,null,1))}}"
```

Capture the full output — both functions' complete policies. Then:

1. **Deployed** — IAM console → the generate function's role → the inline policy JSON.
2. **Deployed** — the Bedrock **Guardrails** console page showing the content and
   sensitive-information policies.
3. The security controls table from `README.md` §5 and the threat-model table from
   `docs/security.md` §1.
4. The limitations list — `README.md` §17 and `docs/security.md` §2.2.

**Why it demonstrates capability.** The synthesised policies are the proof: two functions
with different, minimal permission sets, Bedrock scoped to one model, and no wildcards.
Item 4 matters as much as items 1–3: explicitly stating that IAM authorisation is not
end-user authentication, and naming the work required to close that gap, demonstrates the
professional judgement the subject is assessing. Overclaiming security is the most common
failure mode in portfolio work.

**Supports.** *Build* — security controls, least privilege. Professional practice —
honest self-assessment.

---

## Coverage summary

| Capability from the learning goal | Evidence items |
| --- | --- |
| AWS Lambda | E2, E6, E11 |
| Amazon API Gateway | E5 |
| Amazon DynamoDB | E2, E7 |
| AWS CDK TypeScript | E2, E3, E11 |
| Amazon Bedrock | E8, E13 |
| Infrastructure as Code | E2, E3, E4 |
| Least-privilege IAM | E2, E6, E11, E15 |
| Input validation / AI safety | E5, E9, E13, E15 |
| CloudWatch logging / metrics / tracing | E9, E10 |
| Automated testing | E11 |
| CI/CD | E12 |
| Structured AI evaluation | E13 |
| Architecture documentation | E1 |
| Reproducible deployment | E3, E4, E12 |
| Professional practice | E14, E15 |

## Suggested capture order

**Without deployment** (available now): E1, E2, E3, E11, E12, E13 (mock), E14, E15 (part).

**With a deployed stack** — deploy, then capture in this order so each step produces the
data the next one needs:

1. E4 (stack) → E5 (API config) → E6 (Lambda config) → E7 (table config, empty)
2. Make 2–3 live calls → E8 (Bedrock response + retrieval round trip)
3. E7 again (table with records) → E9 (logs, including the zero-result prompt search)
4. Make one invalid call → E9 (error log line) → E5 (403 unsigned rejection)
5. Wait ~5 minutes for metric aggregation → E10 (dashboard, alarms, traces)
6. E13 (live evaluation run)
7. E15 (deployed IAM role, guardrail console)
8. Only then consider `cdk destroy`

Total live Bedrock invocations needed: roughly 12 (3 manual + 8 evaluation + 1 spare) —
well under one cent on Nova Micro.
