import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { App } from 'aws-cdk-lib'
import { Match, Template } from 'aws-cdk-lib/assertions'
import { beforeAll, describe, expect, it } from 'vitest'
import { AppStack } from '../lib/app-stack.js'
import { SECURE_PARAM_NAMES, SSM_PARAM_IMAGE_TAG, SSM_PARAM_PUBLIC_URL } from '../lib/config.js'

const ENV = { account: '111111111111', region: 'ap-southeast-1' }
const PUBLIC_URL = 'https://airi-web.example.workers.dev'

function synth(): Template {
  const stack = new AppStack(new App(), 'Test', {
    env: ENV,
    instanceType: 't3.small',
    imageTag: 'abc123',
    publicUrl: PUBLIC_URL,
  })
  return Template.fromStack(stack)
}

describe('server bundle', () => {
  const bundleDir = path.join(import.meta.dirname, '../assets/server')

  // CRLF breaks bash on the instance (`set: pipefail: invalid option name`).
  it.each(readdirSync(bundleDir))('%s uses LF line endings', (file) => {
    expect(readFileSync(path.join(bundleDir, file), 'utf8')).not.toContain('\r')
  })

  // An empty ORIGIN_SECRET would weaken the Caddy header check, so deploy.sh must refuse to start.
  it('deploy.sh requires every operator-managed SecureString', () => {
    const script = readFileSync(path.join(bundleDir, 'deploy.sh'), 'utf8')
    for (const name of SECURE_PARAM_NAMES)
      expect(script).toMatch(new RegExp(`REQUIRED_SECURE=\\(.*\\b${name}\\b.*\\)`))
  })

  it('compose gives Caddy only the origin secret, not the OAuth secrets', () => {
    const caddy = readFileSync(path.join(bundleDir, 'compose.yml'), 'utf8').split(/^ {2}caddy:/m)[1]
    expect(caddy).toContain('ORIGIN_SECRET: ${ORIGIN_SECRET}')
    expect(caddy).not.toContain('runtime.env')
  })
})

describe('AppStack', () => {
  let template: Template
  beforeAll(() => {
    template = synth()
  })

  it('creates no NAT gateway, load balancer, database or cache (free tier)', () => {
    for (const type of [
      'AWS::EC2::NatGateway',
      'AWS::ElasticLoadBalancingV2::LoadBalancer',
      'AWS::RDS::DBInstance',
      'AWS::ElastiCache::ServerlessCache',
      'AWS::CloudFront::Distribution',
    ])
      template.resourceCountIs(type, 0)
  })

  it('runs one burstable instance with standard credits and IMDSv2', () => {
    template.resourceCountIs('AWS::EC2::Instance', 1)
    template.hasResourceProperties('AWS::EC2::Instance', {
      InstanceType: 't3.small',
      CreditSpecification: { CPUCredits: 'standard' },
    })
    template.hasResourceProperties('AWS::EC2::LaunchTemplate', {
      LaunchTemplateData: { MetadataOptions: { HttpTokens: 'required' } },
    })
  })

  it('keeps the root volume encrypted, within 30 GiB and after termination', () => {
    template.hasResourceProperties('AWS::EC2::Instance', {
      BlockDeviceMappings: [{
        DeviceName: '/dev/xvda',
        Ebs: { VolumeSize: 30, VolumeType: 'gp3', Encrypted: true, DeleteOnTermination: false },
      }],
    })
  })

  it('opens only 80 and 443 and never SSH', () => {
    const [securityGroup] = Object.values(template.findResources('AWS::EC2::SecurityGroup')) as {
      Properties: { SecurityGroupIngress: { FromPort: number }[] }
    }[]
    expect(securityGroup.Properties.SecurityGroupIngress.map(rule => rule.FromPort).sort()).toEqual([443, 80])
  })

  it('verifies the docker compose binary checksum in user data', () => {
    const [instance] = Object.values(template.findResources('AWS::EC2::Instance')) as {
      Properties: { UserData: unknown }
    }[]
    const userData = JSON.stringify(instance.Properties.UserData)
    expect(userData).toMatch(/sha256sum -c -/)
    expect(userData).toContain('deploy.sh')
  })

  it('publishes image tag and public URL for deploy.sh through SSM', () => {
    template.hasResourceProperties('AWS::SSM::Parameter', { Name: SSM_PARAM_IMAGE_TAG, Value: 'abc123' })
    template.hasResourceProperties('AWS::SSM::Parameter', { Name: SSM_PARAM_PUBLIC_URL, Value: PUBLIC_URL })
  })

  it('lets the instance read only its own SSM parameters', () => {
    const statements = Object.values(template.findResources('AWS::IAM::Policy'))
      .flatMap(policy => (policy as { Properties: { PolicyDocument: { Statement: { Action: unknown, Resource: unknown }[] } } })
        .Properties.PolicyDocument.Statement)
      .filter(statement => JSON.stringify(statement.Action).includes('ssm:GetParameter'))
    expect(statements).toHaveLength(1)
    expect(JSON.stringify(statements[0].Resource)).toContain(':parameter/airi-web/*')
  })

  it('attaches an Elastic IP and snapshots the tagged volume daily', () => {
    template.resourceCountIs('AWS::EC2::EIPAssociation', 1)
    template.hasResourceProperties('AWS::DLM::LifecyclePolicy', {
      PolicyDetails: Match.objectLike({
        TargetTags: [{ Key: 'airi-web-backup', Value: 'daily' }],
        Schedules: [Match.objectLike({ RetainRule: { Count: 3 } })],
      }),
    })
  })
})
