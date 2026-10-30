import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Fn, Stack } from 'aws-cdk-lib'
import * as dlm from 'aws-cdk-lib/aws-dlm'
import * as ec2 from 'aws-cdk-lib/aws-ec2'
import * as ecr from 'aws-cdk-lib/aws-ecr'
import * as iam from 'aws-cdk-lib/aws-iam'
import * as s3assets from 'aws-cdk-lib/aws-s3-assets'
import * as ssm from 'aws-cdk-lib/aws-ssm'
import { Construct } from 'constructs'
import {
  APP_NAME,
  HTTP_PORT,
  HTTPS_PORT,
  IMAGE_SERVICES,
  ROOT_VOLUME_GIB,
  SNAPSHOTS_TO_KEEP,
  SSM_PARAM_BUNDLE_URL,
  SSM_PARAM_IMAGE_TAG,
  SSM_PARAM_PUBLIC_URL,
} from '../config.js'

const BUNDLE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../assets/server')
const APP_DIR = '/opt/airi'
const SWAP_SIZE = '2G'
const COMPOSE_VERSION = 'v5.6.0'
const COMPOSE_SHA256 = '40343e21ca777173e69cff5dbafeb37c6f81f3b0d57d9e597f036e95eb63e76a'
const COMPOSE_URL = `https://github.com/docker/compose/releases/download/${COMPOSE_VERSION}/docker-compose-linux-x86_64`
const BACKUP_TAG_KEY = `${APP_NAME}-backup`
const BACKUP_TAG_VALUE = 'daily'
const SNAPSHOT_TIME_UTC = '19:00' // 02:00 ICT
const SNAPSHOT_INTERVAL_HOURS = 24

export interface ServerProps {
  readonly vpc: ec2.IVpc
  readonly instanceType: string
  readonly imageTag: string
  readonly publicUrl: string
}

/** One EC2 instance running the whole AIRI backend with docker compose. */
export class Server extends Construct {
  readonly instance: ec2.Instance
  readonly originUrl: string

  constructor(scope: Construct, id: string, props: ServerProps) {
    super(scope, id)
    const stack = Stack.of(this)

    const securityGroup = new ec2.SecurityGroup(this, 'Sg', {
      vpc: props.vpc,
      description: 'Caddy: ACME on 80, Worker-to-origin HTTPS on 443 (403 without the origin secret)',
      allowAllOutbound: true,
    })
    securityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(HTTP_PORT), 'ACME HTTP-01 + redirect')
    securityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(HTTPS_PORT), 'Cloudflare Worker origin')

    const role = new iam.Role(this, 'Role', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore')],
    })
    for (const service of IMAGE_SERVICES)
      ecr.Repository.fromRepositoryName(this, `${service}Repo`, `${APP_NAME}/${service}`).grantPull(role)
    role.addToPolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameter', 'ssm:GetParametersByPath'],
      resources: [stack.formatArn({ service: 'ssm', resource: 'parameter', resourceName: `${APP_NAME}/*` })],
    }))

    const bundle = new s3assets.Asset(this, 'Bundle', { path: BUNDLE_DIR })
    bundle.grantRead(role)
    const parameters = [
      new ssm.StringParameter(this, 'BundleUrl', { parameterName: SSM_PARAM_BUNDLE_URL, stringValue: bundle.s3ObjectUrl }),
      new ssm.StringParameter(this, 'ImageTag', { parameterName: SSM_PARAM_IMAGE_TAG, stringValue: props.imageTag }),
      new ssm.StringParameter(this, 'PublicUrl', { parameterName: SSM_PARAM_PUBLIC_URL, stringValue: props.publicUrl }),
    ]

    this.instance = new ec2.Instance(this, 'Instance', {
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      instanceType: new ec2.InstanceType(props.instanceType),
      machineImage: ec2.MachineImage.latestAmazonLinux2023({ cpuType: ec2.AmazonLinuxCpuType.X86_64 }),
      securityGroup,
      role,
      requireImdsv2: true,
      // Standard credits: a burst never turns into a surprise "unlimited" charge.
      creditSpecification: ec2.CpuCredits.STANDARD,
      associatePublicIpAddress: true,
      propagateTagsToVolumeOnCreation: true,
      blockDevices: [{
        deviceName: '/dev/xvda',
        volume: ec2.BlockDeviceVolume.ebs(ROOT_VOLUME_GIB, {
          volumeType: ec2.EbsDeviceVolumeType.GP3,
          encrypted: true,
          deleteOnTermination: false,
        }),
      }],
      userData: this.buildUserData(),
      userDataCausesReplacement: false,
    })
    this.instance.instance.tags.setTag(BACKUP_TAG_KEY, BACKUP_TAG_VALUE)
    // User data reads these on first boot.
    this.instance.node.addDependency(...parameters)

    const eip = new ec2.CfnEIP(this, 'Eip', { domain: 'vpc' })
    new ec2.CfnEIPAssociation(this, 'EipAssociation', {
      allocationId: eip.attrAllocationId,
      instanceId: this.instance.instanceId,
    })
    // sslip.io resolves 1-2-3-4.sslip.io to 1.2.3.4, giving Caddy a name Let's Encrypt can certify.
    this.originUrl = `https://${Fn.join('-', Fn.split('.', eip.attrPublicIp))}.sslip.io`

    this.createSnapshotPolicy()
  }

  private buildUserData(): ec2.UserData {
    const userData = ec2.UserData.forLinux()
    userData.addCommands(
      'set -euo pipefail',
      'export AWS_DEFAULT_REGION="$(cloud-init query region)"',
      'dnf install -y docker unzip',
      'systemctl enable --now docker',
      'mkdir -p /usr/local/lib/docker/cli-plugins',
      `curl -fsSL -o /usr/local/lib/docker/cli-plugins/docker-compose ${COMPOSE_URL}`,
      `echo "${COMPOSE_SHA256}  /usr/local/lib/docker/cli-plugins/docker-compose" | sha256sum -c -`,
      'chmod +x /usr/local/lib/docker/cli-plugins/docker-compose',
      `if [ ! -f /swapfile ]; then fallocate -l ${SWAP_SIZE} /swapfile && chmod 600 /swapfile`
      + ' && mkswap /swapfile && swapon /swapfile && echo "/swapfile none swap sw 0 0" >> /etc/fstab; fi',
      `mkdir -p ${APP_DIR}`,
      `aws s3 cp "$(aws ssm get-parameter --name ${SSM_PARAM_BUNDLE_URL} --query Parameter.Value --output text)"`
      + ' /tmp/bundle.zip',
      `unzip -oq /tmp/bundle.zip -d ${APP_DIR} && rm -f /tmp/bundle.zip`,
      `bash ${APP_DIR}/deploy.sh || echo "deploy.sh failed; rerun via SSM"`,
    )
    return userData
  }

  private createSnapshotPolicy(): void {
    const role = new iam.Role(this, 'SnapshotRole', {
      assumedBy: new iam.ServicePrincipal('dlm.amazonaws.com'),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSDataLifecycleManagerServiceRole')],
    })
    new dlm.CfnLifecyclePolicy(this, 'Snapshots', {
      description: `${APP_NAME} daily root volume snapshots`,
      state: 'ENABLED',
      executionRoleArn: role.roleArn,
      policyDetails: {
        resourceTypes: ['VOLUME'],
        targetTags: [{ key: BACKUP_TAG_KEY, value: BACKUP_TAG_VALUE }],
        schedules: [{
          name: 'daily',
          createRule: { interval: SNAPSHOT_INTERVAL_HOURS, intervalUnit: 'HOURS', times: [SNAPSHOT_TIME_UTC] },
          retainRule: { count: SNAPSHOTS_TO_KEEP },
          copyTags: true,
        }],
      },
    })
  }
}
