#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { AwsS3InterfaceVpceStack } from '../lib/aws-s3-interface-vpce-stack';

const app = new cdk.App();
new AwsS3InterfaceVpceStack(app, 'AwsS3InterfaceVpceStack', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION }
});