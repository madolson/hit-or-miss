const path = require('node:path');
const cdk = require('aws-cdk-lib');
const ec2 = require('aws-cdk-lib/aws-ec2');
const ecs = require('aws-cdk-lib/aws-ecs');
const ecsPatterns = require('aws-cdk-lib/aws-ecs-patterns');
const elasticache = require('aws-cdk-lib/aws-elasticache');
const secrets = require('aws-cdk-lib/aws-secretsmanager');
const { Platform } = require('aws-cdk-lib/aws-ecr-assets');

class GameStack extends cdk.Stack {
  constructor(scope, id, props) {
    super(scope, id, props);

    // No NAT: tasks sit in public subnets (reachable only from the ALB), Valkey in isolated ones.
    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        { name: 'public', subnetType: ec2.SubnetType.PUBLIC },
        { name: 'cache', subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      ],
    });

    const cacheSg = new ec2.SecurityGroup(this, 'CacheSg', { vpc });
    const subnets = new elasticache.CfnSubnetGroup(this, 'CacheSubnets', {
      description: 'valkey game tracker',
      subnetIds: vpc.isolatedSubnets.map((s) => s.subnetId),
    });

    const cache = new elasticache.CfnReplicationGroup(this, 'Valkey', {
      replicationGroupDescription: 'valkey game tracker',
      engine: 'valkey',
      engineVersion: '9.1',
      cacheNodeType: 'cache.t4g.small',
      numCacheClusters: 2, // 1 primary, 1 replica
      automaticFailoverEnabled: true,
      multiAzEnabled: true,
      durability: 'sync',
      transitEncryptionEnabled: true,
      atRestEncryptionEnabled: true,
      cacheSubnetGroupName: subnets.ref,
      securityGroupIds: [cacheSg.securityGroupId],
    });

    const hostKey = new secrets.Secret(this, 'HostKey', {
      generateSecretString: { excludePunctuation: true, passwordLength: 16 },
    });

    const svc = new ecsPatterns.ApplicationLoadBalancedFargateService(this, 'Web', {
      vpc,
      desiredCount: 2,
      cpu: 256,
      memoryLimitMiB: 512,
      publicLoadBalancer: true,
      assignPublicIp: true,
      taskSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      runtimePlatform: { cpuArchitecture: ecs.CpuArchitecture.ARM64 },
      circuitBreaker: { rollback: true },
      taskImageOptions: {
        image: ecs.ContainerImage.fromAsset(path.join(__dirname, '../../app'), { platform: Platform.LINUX_ARM64 }),
        containerPort: 8080,
        environment: {
          VALKEY_HOST: cache.attrPrimaryEndPointAddress,
          VALKEY_PORT: cache.attrPrimaryEndPointPort,
          VALKEY_TLS: '1',
        },
        secrets: { HOST_KEY: ecs.Secret.fromSecretsManager(hostKey) },
      },
    });
    svc.targetGroup.configureHealthCheck({ path: '/healthz' });
    svc.targetGroup.setAttribute('deregistration_delay.timeout_seconds', '10');
    cacheSg.addIngressRule(svc.service.connections.securityGroups[0], ec2.Port.tcp(6379));

    new cdk.CfnOutput(this, 'HostUrl', { value: `http://${svc.loadBalancer.loadBalancerDnsName}/host` });
    new cdk.CfnOutput(this, 'HostKeyCommand', {
      value: `aws secretsmanager get-secret-value --region ${this.region} --secret-id ${hostKey.secretArn} --query SecretString --output text`,
    });
  }
}

const app = new cdk.App();
new GameStack(app, 'ValkeyGameTracker', { env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: 'us-west-2' } });
