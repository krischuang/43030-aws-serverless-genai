# Professional learning reflection

*UTS 43030 Professional Practice in Computing — Assessment 3*
*Learning goal: build and evaluate a secure AWS serverless generative AI application.*

## Starting point

I did not come to this project new to the technologies in it. I already had practical
experience with AWS, Python and TypeScript, Docker, CI/CD, designing and consuming APIs,
authentication, production reliability work, Amazon Bedrock, and software testing. Several
of those I had used in anger, under deadline, with real users affected when they went
wrong.

That matters for how I frame the learning, because the honest version is not "I learned
AWS." It is that I had these capabilities as **separate** competencies — Lambda from one
context, IAM from another, Bedrock from experimentation, testing from application work —
and had never been forced to make them agree with each other inside one small, complete,
reproducible system that someone else could review.

## What the project actually required

The learning goal has two verbs, *build* and *evaluate*, and the second turned out to be
the harder one.

Building was integration work. The system is small by design — two endpoints, two Lambda
functions, around 1,200 lines of source — but every layer a real serverless AI service
needs is present: authorisation, edge validation, application validation, model
invocation with safety controls, persistence with data minimisation, structured
observability, automated tests, CI, and documentation. The difficulty was not in any one
layer. It was that the layers constrain each other, and I had not previously had to
resolve those constraints in one place.

## The five things that genuinely changed how I work

**1. Least privilege is only real if it is asserted.**

I have written IAM policies for years, but my habit was to reach for the convenient CDK
grant — `grantReadWriteData` — and move on. Here I used `table.grant(fn, 'dynamodb:PutItem')`
and `table.grant(fn, 'dynamodb:GetItem')`, which forced a design consequence I had not
anticipated: the two endpoints had to be **separate Lambda functions**, because a single
router would need the union of both permission sets and "least privilege" would become a
claim rather than a property.

Then I wrote a test asserting that the complete set of DynamoDB actions anywhere in the
synthesised template is exactly `['dynamodb:GetItem', 'dynamodb:PutItem']`. That test is
the part I will carry forward. A policy review happens once; an assertion fails on every
future commit that weakens it. Security properties encoded as executable tests are
durable in a way that reviewed security properties are not.

**2. Some infrastructure mistakes are invisible until deployment.**

Bedrock has two addressing styles. A foundation model id like `amazon.nova-micro-v1:0`
needs a regional `foundation-model/...` ARN. A cross-region inference profile id like
`apac.amazon.nova-micro-v1:0` needs the account-scoped `inference-profile/...` ARN **and**
a region-wildcarded `foundation-model/...` ARN for the underlying model. Get it wrong and
nothing fails at synthesis, nothing fails at deployment, and nothing fails until the
first live invocation returns `AccessDeniedException`.

That changed how I think about where to put care. I isolated the logic in its own module
(`lib/bedrock-permissions.ts`) with its own tests, specifically because it is the piece
with the longest gap between making a mistake and finding out. The general lesson: when
feedback is delayed, raise the local rigour — don't rely on the deployment to tell you.

**3. Data protection works better as a type-level concern than a review checklist.**

The requirement "don't log user prompts" is easy to agree to and easy to violate, because
`logger.info('accepted', { prompt })` is the natural thing to type at 11pm. So I moved the
rule into the logger itself: `prompt`, `response`, `token`, `secret` and similar field
names are on a deny-list, and a call site that passes them gets `"[redacted]"`. I made the
same decision in the data layer — the raw prompt is never persisted, only its length and a
SHA-256 fingerprint.

Both choices mean the safe behaviour is the default and the unsafe behaviour requires
deliberately defeating a mechanism. I had previously treated this class of requirement as
a code-review responsibility. Making it structural is strictly better, and it is cheap.

The corresponding evidence is a *negative* one: searching the log group for a distinctive
word from a prompt and getting zero results. I had not thought of negative evidence as a
category before this project, and it is now the first thing I look for when someone claims
a system doesn't do something.

**4. An evaluation harness can lie, and the fix is a third verdict.**

This was the most useful thing I learned, and it came from nearly getting it wrong.

My first version of the evaluation scorer had two verdicts, pass and fail. Run in mock
mode — where the Bedrock client is stubbed and the model output is canned — it reported
13/13 passing. That was technically true of what it measured and completely misleading: a
run with no model involved at all looked like a clean sweep, including dimensions like
"relevance" and "format compliance" that depend entirely on real model output.

Adding a `skipped` verdict fixed it. Now mock mode reports 20 pass, 0 fail, **16 skipped**,
and the report header states that response-quality dimensions cannot be judged without a
live model. The number got less impressive and the artefact got much more trustworthy.

The general principle — *an evaluation that cannot express "I don't know" will silently
report confidence it hasn't earned* — applies well beyond this project. I expect to apply
it to monitoring and test reporting more broadly: a green dashboard that cannot
distinguish "healthy" from "not measured" is a liability.

**5. Architectural trade-offs are worth writing down at the moment you make them.**

I documented why REST API over HTTP API (request validators and access-log field
selection, at the cost of slightly higher per-request price), why Converse over
InvokeModel (uniform shape across model families, which is what makes the model id genuine
configuration), why no Secrets Manager (there are no secrets, and adding it to store
nothing would be security theatre), why a dependency-free logger over Powertools (the
mechanics being demonstrated would be hidden behind a decorator), and why I bundle the AWS
SDK rather than using the runtime's copy (reproducibility against a pinned version).

Writing these down while deciding, rather than afterwards, changed some decisions. Several
rationales were weak when I tried to articulate them and I revised the choice instead of
the prose. That is a cheap technique I had not used deliberately before.

## What I got wrong along the way

- I initially pinned `aws-cdk-lib` to an old minor version out of caution, which pulled in
  a set of CDK security advisories. Moving to the current release resolved them. Caution
  about dependency versions is not the same as safety.
- I tried to resolve every `npm audit` finding, and eventually established that the
  remaining ones are DoS advisories in build tooling (`brace-expansion` via Jest, ESLint
  and the CDK CLI's *vendored* `minimatch`, which an npm `overrides` entry cannot reach)
  with no published fix. The right answer was to document the finding precisely and
  explain why CI does not gate on it, rather than add a gate configured to ignore the only
  findings it would ever produce.
- I used the deprecated Node.js 20 Lambda runtime until `cdk synth` warned me. A warning I
  would previously have skimmed past.
- My first logger implementation used `Object.assign` against a readonly field to build
  child loggers — it worked, and it was the kind of thing that is fine until someone
  refactors near it.

## What this is not

I want to be precise about the ceiling of this work, because overclaiming would undercut
the point of the exercise.

It is **not production-ready** in several specific ways. IAM authorisation authenticates
an AWS principal, not an application user: there are no user accounts, sessions, consent
records or per-user quotas, and closing that gap means a real identity provider. The
prompt-injection defences — a pinned system prompt, a Bedrock guardrail, and regex
flagging — are mitigations, not security boundaries, and the heuristics are bypassable by
rephrasing. The evaluation suite has thirteen cases scored by deterministic string
matching, which demonstrates a method rather than providing coverage. There is no load
testing, so the latency figures are samples rather than distributions. Tracing covers
API→Lambda but not the SDK calls inside the handler.

It is also **not large**, deliberately. It is a learning artefact sized so that a reviewer
can read it end to end and a deployment costs cents.

## What I would do next

In the order I would actually do them: real end-user authentication with per-user quotas;
X-Ray SDK instrumentation so Bedrock latency appears in a trace rather than only in logs;
model-graded evaluation to lift the relevance dimension beyond keyword matching; and
`cdk-nag` in CI. The full list, with reasoning, is in `docs/architecture.md` §5.

## Summary

The capability I built here is **integration and judgement**, not new tooling knowledge. I
can now take a set of AWS services I already knew individually and compose them into one
small system where the security model, the observability model, the test strategy and the
AI evaluation are mutually consistent, expressed entirely as code, reproducible by someone
else, and documented honestly enough that a reader can tell what it does not do.

The most transferable thing I take away is narrower and more useful than that, though: the
`skipped` verdict. Build measurement systems that can say "I don't know," because the
alternative is a system that reports confidence it has not earned — and that is a harder
failure to notice than a red build.
