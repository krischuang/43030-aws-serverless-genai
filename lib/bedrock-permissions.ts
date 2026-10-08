/**
 * Builds the narrowest set of Bedrock resource ARNs that a given model id
 * requires, so the Lambda execution role never needs a wildcard on
 * bedrock:InvokeModel.
 *
 * Bedrock exposes two addressing styles:
 *
 *  - A foundation model id such as "amazon.nova-micro-v1:0" is invoked
 *    directly and only needs the regional foundation-model ARN.
 *  - A cross-region inference profile id such as "apac.amazon.nova-micro-v1:0"
 *    is invoked through an account-scoped inference-profile resource, which in
 *    turn fans out to the underlying foundation model in any region of that
 *    geography. Both ARNs must therefore be allowed.
 */

import { Aws, Stack } from 'aws-cdk-lib';

export interface BedrockModelResources {
  readonly resourceArns: string[];
  readonly isInferenceProfile: boolean;
  readonly baseModelId: string;
}

/**
 * An inference profile id carries a geography prefix, giving three
 * dot-separated segments ("apac.amazon.nova-micro-v1:0") where a plain
 * foundation model id has two ("amazon.nova-micro-v1:0").
 */
export function resolveBedrockModelResources(
  stack: Stack,
  modelId: string,
): BedrockModelResources {
  const segments = modelId.split('.');
  const isInferenceProfile = segments.length >= 3;
  const baseModelId = isInferenceProfile ? segments.slice(1).join('.') : modelId;

  const foundationModelArn = `arn:${Aws.PARTITION}:bedrock:${
    isInferenceProfile ? '*' : stack.region
  }::foundation-model/${baseModelId}`;

  if (!isInferenceProfile) {
    return { resourceArns: [foundationModelArn], isInferenceProfile, baseModelId };
  }

  const inferenceProfileArn = stack.formatArn({
    service: 'bedrock',
    resource: 'inference-profile',
    resourceName: modelId,
  });

  return {
    resourceArns: [foundationModelArn, inferenceProfileArn],
    isInferenceProfile,
    baseModelId,
  };
}
