/**
 *  Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 *
 *  Licensed under the Apache License, Version 2.0 (the "License"). You may not use this file except in compliance
 *  with the License. A copy of the License is located at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 *  or in the 'license' file accompanying this file. This file is distributed on an 'AS IS' BASIS, WITHOUT WARRANTIES
 *  OR CONDITIONS OF ANY KIND, express or implied. See the License for the specific language governing permissions
 *  and limitations under the License.
 */

import { App, Stack } from 'aws-cdk-lib';
import { BootstraplessStackSynthesizer } from 'cdk-bootstrapless-synthesizer';
import { NagPackSuppression, NagSuppressions } from 'cdk-nag';
import { CloudFrontFrontendAppStack } from './cloudfront-frontend-app-stack';

const app = new App();

function stackSuppressions(stacks: Stack[], suppressions: NagPackSuppression[]) {
  stacks.forEach(s => {
    NagSuppressions.addStackSuppressions(s, suppressions, true);
  });
}

const commonSuppresionRulesForCloudFrontS3Pattern = [
  { id: 'AwsSolutions-IAM4', reason: 'Cause by CDK BucketDeployment construct (aws-cdk-lib/aws-s3-deployment)' },
  { id: 'AwsSolutions-IAM5', reason: 'Cause by CDK BucketDeployment construct (aws-cdk-lib/aws-s3-deployment)' },
  { id: 'AwsSolutions-APIG2', reason: 'The REST API input validation in Lambda(Express) code, the front ApiGateway does not need repeated validation.' },
  { id: 'AwsSolutions-COG4', reason: 'The REST API validate input via OIDC authorizer, there is no need to use Cognito user pool authorizer.' },
];

stackSuppressions([
  new CloudFrontFrontendAppStack(app, 'cloudfront-s3-frontend-app-stack-cn', {
    targetToCNRegions: true,
    useCustomDomainName: true,
    synthesizer: synthesizer(),
  }),
], [
  ...commonSuppresionRulesForCloudFrontS3Pattern,
  { id: 'AwsSolutions-CFR4', reason: 'TLSv1 is required in China regions' },
]);

const commonSuppresionRulesForCloudFrontS3PatternInGloabl = [
  ...commonSuppresionRulesForCloudFrontS3Pattern,
  { id: 'AwsSolutions-CFR4', reason: 'Cause by using default default CloudFront viewer certificate' },
  { id: 'AwsSolutions-L1', reason: 'Managed by CDK Cognito module for get service token' },
];

stackSuppressions([
  new CloudFrontFrontendAppStack(app, 'cloudfront-s3-frontend-app-stack-global', {
    synthesizer: synthesizer(),
  }),
], commonSuppresionRulesForCloudFrontS3PatternInGloabl);

stackSuppressions([
  new CloudFrontFrontendAppStack(app, 'cloudfront-s3-frontend-app-stack-global-customdomain', {
    useCustomDomainName: true,
    synthesizer: synthesizer(),
  }),
], [
  ...commonSuppresionRulesForCloudFrontS3PatternInGloabl,
  { id: 'AwsSolutions-L1', reason: 'Caused by CDK DnsValidatedCertificate resource when request ACM certificate' },
]);

function synthesizer() {
  return process.env.USE_BSS ? new BootstraplessStackSynthesizer() : undefined;
}