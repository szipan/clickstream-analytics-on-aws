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

import { join } from 'path';
import { Aspects, Aws, CfnOutput, CfnResource, DockerImage, Fn, IAspect, Stack, StackProps } from 'aws-cdk-lib';
import { DnsValidatedCertificate } from 'aws-cdk-lib/aws-certificatemanager';
import {
  CfnDistribution,
  FunctionCode,
  FunctionEventType,
  Function,
  ResponseHeadersPolicy,
} from 'aws-cdk-lib/aws-cloudfront';
import { FunctionAssociation } from 'aws-cdk-lib/aws-cloudfront/lib/function';
import { HostedZone } from 'aws-cdk-lib/aws-route53';
import { Source } from 'aws-cdk-lib/aws-s3-deployment';
import { NagSuppressions } from 'cdk-nag';
import { Construct, IConstruct } from 'constructs';
import { addCfnNagForCustomResourceProvider, addCfnNagForLogRetention, addCfnNagToStack } from './common/cfn-nag';
import { OUTPUT_CONTROL_PLANE_BUCKET, OUTPUT_CONTROL_PLANE_URL } from './common/constant';
import { Parameters } from './common/parameters';
import { SolutionBucket } from './common/solution-bucket';
import { SolutionInfo } from './common/solution-info';
import { getShortIdOfStack } from './common/stack';
import { CloudFrontS3Portal, CNCloudFrontS3PortalProps, DomainProps } from './control-plane/cloudfront-s3-portal';
import { Constant } from './control-plane/private/constant';
import { suppressWarningsForCloudFrontS3Portal as suppressWarningsForCloudFrontS3Portal } from './control-plane/private/nag';
import { generateSolutionConfig, SOLUTION_CONFIG_PATH } from './control-plane/private/solution-config';

export interface CloudFrontFrontendAppStackProps extends StackProps {
  /**
   * Indicate whether to create stack in CN regions
   *
   * @default - false.
   */
  targetToCNRegions?: boolean;

  /**
   * Whether to use custom domain name
   */
  useCustomDomainName?: boolean;

  /**
   * user existing OIDC provider or not
   */
  useExistingOIDCProvider?: boolean;
}

export class CloudFrontFrontendAppStack extends Stack {

  private paramGroups: any[] = [];
  private paramLabels: any = {};

  constructor(scope: Construct, id: string, props?: CloudFrontFrontendAppStackProps) {
    super(scope, id, props);

    this.templateOptions.description = SolutionInfo.DESCRIPTION + '- Control Plane';

    let domainProps: DomainProps | undefined = undefined;
    let cnCloudFrontS3PortalProps: CNCloudFrontS3PortalProps | undefined;
    const solutionBucket = new SolutionBucket(this, 'ClickstreamSolution');

    if (props?.targetToCNRegions) {
      const iamCertificateId = Parameters.createIAMCertificateIdParameter(this);
      this.addToParamLabels('Certificate Id', iamCertificateId.logicalId);

      const domainName = Parameters.createDomainNameParameter(this);
      this.addToParamLabels('Domain Name', domainName.logicalId);

      cnCloudFrontS3PortalProps = {
        domainName: domainName.valueAsString,
        iamCertificateId: iamCertificateId.valueAsString,
      };

      Aspects.of(this).add(new InjectCustomResourceConfig('true'));

      this.addToParamGroups(
        'Domain Information',
        iamCertificateId.logicalId,
        domainName.logicalId,
      );
    } else {
      if (props?.useCustomDomainName) {

        const domainParameters = Parameters.createDomainParameters(this, this.paramGroups, this.paramLabels);

        const hostedZone = HostedZone.fromHostedZoneAttributes(this, 'hostZone', {
          hostedZoneId: domainParameters.hostedZoneId.valueAsString,
          zoneName: domainParameters.hostedZoneName.valueAsString,
        });

        const certificate = new DnsValidatedCertificate(this, 'certificate', {
          domainName: Fn.join('.', [domainParameters.recordName.valueAsString, domainParameters.hostedZoneName.valueAsString]),
          hostedZone: hostedZone,
          region: 'us-east-1',
        });

        domainProps = {
          hostZone: hostedZone,
          recordName: domainParameters.recordName.valueAsString,
          certificate: certificate,
        };
      }
    }

    const functionAssociations: FunctionAssociation[] = [];
    if (!props?.targetToCNRegions) {
      functionAssociations.push({
        function: new Function(this, 'FrontRewriteFunction', {
          functionName: `FrontRewriteFunction-${Aws.REGION}-${getShortIdOfStack(this)}`,
          code: FunctionCode.fromInline(`function handler(event) {
  var request = event.request;
  var uri = request.uri;
  if (uri.startsWith('/signin') || 
    uri.startsWith('/projects') || 
    uri.startsWith('/project') || 
    uri.startsWith('/pipelines') || 
    uri.startsWith('/plugins') || 
    uri.startsWith('/alarms') || 
    uri.startsWith('/user') || 
    uri.startsWith('/analytics') || 
    uri.startsWith('/quicksight')) {
      request.uri = '/index.html'; 
  }
  return request; 
}`),
        }),
        eventType: FunctionEventType.VIEWER_REQUEST,
      });
    }

    let responseHeadersPolicy: ResponseHeadersPolicy | undefined = undefined;

    const buildScript: string = this.node.tryGetContext('BuildScript');

    const controlPlane = new CloudFrontS3Portal(this, 'cloudfront_control_plane', {
      frontendProps: {
        assetPath: join(__dirname, '..'),

        dockerImage: DockerImage.fromRegistry(Constant.NODE_IMAGE_V18),
        buildCommand: [
          'bash', '-c',
          buildScript,
        ],
        environment: {
          GENERATE_SOURCEMAP: process.env.GENERATE_SOURCEMAP ?? 'false',
        },
        user: 'node',
        autoInvalidFilePaths: ['/index.html', '/asset-manifest.json', '/robots.txt', SOLUTION_CONFIG_PATH, '/locales/*'],
      },
      cnCloudFrontS3PortalProps,
      domainProps,
      distributionProps: {
        logProps: {
          enableAccessLog: true,
          bucket: solutionBucket.bucket,
        },
        functionAssociations: functionAssociations,
        responseHeadersPolicy,
      },
    });

    // upload config to S3
    const key = SOLUTION_CONFIG_PATH.substring(1); //remove slash
    const awsExports = generateSolutionConfig({
      solutionVersion: process.env.BUILD_VERSION || 'v1',
      controlPlaneMode: 'CLOUDFRONT',
      solutionBucket: solutionBucket.bucket.bucketName,
      solutionPluginPrefix: '',
      solutionRegion: Aws.REGION,
    });

    controlPlane.bucketDeployment.addSource(Source.jsonData(key, awsExports));

    if (props?.targetToCNRegions) {
      const portalDist = controlPlane.distribution.node.defaultChild as CfnDistribution;

      //This is a tricky to avoid 403 error when access paths except /index.html
      portalDist.addPropertyOverride(
        'DistributionConfig.CustomErrorResponses',
        [
          {
            ErrorCode: 403,
            ResponseCode: 200,
            ResponsePagePath: '/index.html',
          },
        ],
      );
    }

    this.templateOptions.metadata = {
      'AWS::CloudFormation::Interface': {
        ParameterGroups: this.paramGroups,
        ParameterLabels: this.paramLabels,
      },
    };

    //suppress nag warnings
    suppressWarningsForCloudFrontS3Portal(this);

    new CfnOutput(this, OUTPUT_CONTROL_PLANE_URL, {
      description: 'The url of clickstream console',
      value: controlPlane.controlPlaneUrl,
    }).overrideLogicalId(OUTPUT_CONTROL_PLANE_URL);

    new CfnOutput(this, OUTPUT_CONTROL_PLANE_BUCKET, {
      description: 'Bucket to store solution console data and services logs',
      value: controlPlane.logBucket.bucketName,
    }).overrideLogicalId(OUTPUT_CONTROL_PLANE_BUCKET);

    if (cnCloudFrontS3PortalProps !== undefined) {
      new CfnOutput(this, 'CloudFrontDomainName', {
        description: 'CloudFront domain name',
        value: controlPlane.distribution.distributionDomainName,
      }).overrideLogicalId('CloudFrontDomainName');
    }

    // nag
    addCfnNag(this);
  }

  private addToParamGroups(label: string, ...param: string[]) {
    this.paramGroups.push({
      Label: { default: label },
      Parameters: param,
    });
  }

  private addToParamLabels(label: string, param: string) {
    this.paramLabels[param] = {
      default: label,
    };
  }
}

class InjectCustomResourceConfig implements IAspect {
  public constructor(private isInstallLatestAwsSdk: string) { }

  public visit(node: IConstruct): void {
    if (
      node instanceof CfnResource &&
      node.cfnResourceType === 'Custom::AWS'
    ) {
      node.addPropertyOverride('InstallLatestAwsSdk', this.isInstallLatestAwsSdk);
    }
  }
}

function addCfnNag(stack: Stack) {
  const cfnNagList = [
    {
      paths_endswith: [
        'ClickStreamApi/ApiGatewayAccessLogs/Resource',
      ],
      rules_to_suppress: [
        {
          id: 'W84',
          reason:
            'By default CloudWatchLogs LogGroups data is encrypted using the CloudWatch server-side encryption keys (AWS Managed Keys)',
        },
      ],
    },
    {
      paths_endswith: [
        'ClickStreamApi/ClickStreamApiFunctionRole/DefaultPolicy/Resource',
      ],
      rules_to_suppress: [
        {
          id: 'W76',
          reason:
            'This policy needs to be able to call other AWS service by design',
        },
      ],
    },
    {
      paths_endswith: [
        'AWS679f53fac002430cb0da5b7982bd2287/Resource',
      ],
      rules_to_suppress: [
        {
          id: 'W89',
          reason:
            'Lambda function is only used as cloudformation custom resources or per product design, no need to be deployed in VPC',
        },
        {
          id: 'W92',
          reason:
            'Lambda function is only used as cloudformation custom resources or per product design, no need to set ReservedConcurrentExecutions',
        },
      ],
    },
  ];
  addCfnNagToStack(stack, cfnNagList);
  addCfnNagForLogRetention(stack);
  addCfnNagForCustomResourceProvider(stack, 'CDK built-in provider for DicInitCustomResourceProvider', 'DicInitCustomResourceProvider');
  NagSuppressions.addStackSuppressions(stack, [
    {
      id: 'AwsSolutions-IAM4',
      reason:
        'LogRetention lambda role which are created by CDK uses AWSLambdaBasicExecutionRole',
    },
    {
      id: 'AwsSolutions-L1',
      // The non-container Lambda function is not configured to use the latest runtime version
      reason:
        'The lambda is created by CDK, CustomResource framework-onEvent, the runtime version will be upgraded by CDK',
    },
  ]);
}


