#!/usr/bin/env node
/**
 * CDK application entry point.
 *
 * The environment is taken from the standard CDK_DEFAULT_* variables so the
 * same code synthesises for any account and region without edits.
 */

import { App } from 'aws-cdk-lib';
import { ServerlessGenAiStack } from '../lib/serverless-genai-stack';
import { resolveSettings } from '../lib/stack-config';

const app = new App();
const settings = resolveSettings(app);

new ServerlessGenAiStack(app, `ServerlessGenAi-${settings.environmentName}`, {
  settings,
  description: 'Secure serverless generative AI request service (UTS 43030 professional learning)',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});

app.synth();
