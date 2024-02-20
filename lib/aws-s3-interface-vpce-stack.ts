import * as cdk from 'aws-cdk-lib';
import { Certificate } from 'aws-cdk-lib/aws-certificatemanager';
import { BastionHostLinux, GatewayVpcEndpointAwsService, InterfaceVpcEndpointAwsService, MachineImage, Peer, Port, SecurityGroup, Vpc } from 'aws-cdk-lib/aws-ec2';
import { ApplicationListenerRule, ApplicationLoadBalancer, ApplicationProtocol, ListenerAction, ListenerCondition, Protocol, SslPolicy } from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { IpTarget } from 'aws-cdk-lib/aws-elasticloadbalancingv2-targets';
import { AnyPrincipal, Effect, ManagedPolicy, PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { ARecord, PrivateHostedZone, RecordTarget } from 'aws-cdk-lib/aws-route53';
import { LoadBalancerTarget } from 'aws-cdk-lib/aws-route53-targets';
import { Bucket, BucketEncryption } from 'aws-cdk-lib/aws-s3';
import { BucketDeployment, Source } from 'aws-cdk-lib/aws-s3-deployment';
import { StringParameter } from 'aws-cdk-lib/aws-ssm';
import { AwsCustomResource, PhysicalResourceId } from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';
import path = require('path');

export class AwsS3InterfaceVpceStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    
    const zoneName = 'app.mydomain.pvt';
    const vpc = new Vpc(this, 'app-vpc', {
      maxAzs: 2,
      natGateways: 1,
      gatewayEndpoints: {
        S3: {service: GatewayVpcEndpointAwsService.S3}
      },      
    });
    
    const vpce_sg = new SecurityGroup(this, 'vpc-sg', {
      vpc:vpc
    });

    vpce_sg.addIngressRule(Peer.ipv4(vpc.vpcCidrBlock), Port.tcp(443));

    const s3Vpce = vpc.addInterfaceEndpoint('s3-vpce', {
      service: InterfaceVpcEndpointAwsService.S3,
      securityGroups: [vpce_sg],
      privateDnsEnabled: true,
    });
    s3Vpce.node.addDependency(vpc);

    const zone = new PrivateHostedZone(this, 'phz', {
      zoneName,
      vpc
    });
    zone.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    const alb_sg = new SecurityGroup(this, 'alb-sg', { vpc:vpc });
    alb_sg.addIngressRule(Peer.ipv4(vpc.vpcCidrBlock), Port.tcp(443));
    
    const alb = new ApplicationLoadBalancer(this, 'alb', { 
      vpc,
      securityGroup: alb_sg
    });

    const arecord = new ARecord(this, 'a-rec', {
      zone,
      target: RecordTarget.fromAlias(new LoadBalancerTarget(alb))
    });

    const cert = Certificate.fromCertificateArn(this, 'albcert', StringParameter.valueForStringParameter(this, 'cert-arn'));
    const listener = alb.addListener('s3-vpce-listener', {
      port: 443,
      open: false,
      protocol: ApplicationProtocol.HTTPS,
      certificates: [cert],
      sslPolicy: SslPolicy.FORWARD_SECRECY_TLS12,
      defaultAction: ListenerAction.fixedResponse(404)
    });
    
    // add vpce port.  Well,,,
    const eni = new AwsCustomResource(this, 'enilist', {
      onCreate: {
        service: 'EC2',
        action: 'describeNetworkInterfaces',
        parameters: {
          NetworkInterfaceIds: s3Vpce.vpcEndpointNetworkInterfaceIds
        },
        physicalResourceId: PhysicalResourceId.of(Date.now().toString())
      },
      onUpdate: {
        service: 'EC2',
        action: 'describeNetworkInterfaces',
        parameters: {
          NetworkInterfaceIds: s3Vpce.vpcEndpointNetworkInterfaceIds
        },
        physicalResourceId: PhysicalResourceId.of(Date.now().toString())
      },
      policy: {
        statements: [
          new PolicyStatement({
            actions: ["ec2:DescribeNetworkInterfaces"],
            resources: ["*"]
          })
        ]
      }
    });

    listener.addTargets('s3-vpce-target', {
      port: 443,
      targets: [
        new IpTarget(eni.getResponseField("NetworkInterfaces.0.PrivateIpAddress")),
        new IpTarget(eni.getResponseField("NetworkInterfaces.1.PrivateIpAddress"))
      ],
      protocol: ApplicationProtocol.HTTPS,
      healthCheck: {
        path: '/',
        port: '443',
        protocol: Protocol.HTTPS,
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 10,
        timeout: cdk.Duration.seconds(10),
        interval: cdk.Duration.seconds(20)
      }
    });

    const listenerRule = new ApplicationListenerRule(this, 'main', {
      listener,
      priority: 10,
      conditions: [ListenerCondition.pathPatterns(['*/'])],
      action: ListenerAction.redirect({
        host: '#{host}',
        port: '#{port}',
        path: '/#{path}index.html',
        query: '#{query}'
      })
    });

    const bucket = new Bucket(this, 's3-bucket', {
      bucketName: zoneName,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      encryption: BucketEncryption.S3_MANAGED,
    });

    const policy = new PolicyStatement({
      actions: [ 's3:GetObject' ],
      effect: Effect.ALLOW,
      resources: [bucket.bucketArn, `${bucket.bucketArn}/*`],
      conditions: {
        'StringEquals': {
          'aws:SourceVpce': s3Vpce.vpcEndpointId
        }
      },
      principals: [new AnyPrincipal()]
    });
    bucket.addToResourcePolicy(policy);

    const appPath = path.resolve(path.join(__dirname, '../app'));
    const deploy = new BucketDeployment(this, 'angular-app', {
      destinationBucket: bucket,
      sources: [
        Source.asset(appPath, {
          bundling: {
            image:  cdk.DockerImage.fromRegistry("node:lts"),
            command: [
              'bash', '-c', [
                'npm ci',
                'npm run build',
                'cp -r /asset-input/dist/app/browser/* /asset-output/'
              ].join(' && '),
            ],
          },
        })
      ],
      retainOnDelete: false
    });

    new cdk.CfnOutput(this, 'domain-url', {
      value: 'https://app.mydomain.pvt/',
      exportName: 'aws-s3-vpce-domainName'
    });

    // testing server
    const instance = new BastionHostLinux(this, 'my-ec2', {
      vpc,
      requireImdsv2: true,
      machineImage: MachineImage.latestAmazonLinux2(),
    });

    instance.role.addManagedPolicy(ManagedPolicy.fromAwsManagedPolicyName('AdministratorAccess'));
    instance.role.addManagedPolicy(ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMFullAccess'));
  }
}
