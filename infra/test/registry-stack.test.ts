import { App } from 'aws-cdk-lib'
import { Match, Template } from 'aws-cdk-lib/assertions'
import { describe, expect, it } from 'vitest'
import { readDeployConfig } from '../lib/config.js'
import { RegistryStack } from '../lib/registry-stack.js'

const ENV = { account: '111111111111', region: 'ap-southeast-1' }

function synth(githubRepo?: string, githubOidcProviderArn?: string): Template {
  return Template.fromStack(new RegistryStack(new App(), 'Registry', { env: ENV, githubRepo, githubOidcProviderArn }))
}

describe('RegistryStack', () => {
  it('creates immutable, scanned image repositories for api and auth', () => {
    const template = synth()
    template.resourcePropertiesCountIs('AWS::ECR::Repository', {
      ImageTagMutability: 'IMMUTABLE',
      ImageScanningConfiguration: { ScanOnPush: true },
    }, 2)
  })

  it('creates no CI role when githubRepo is not set', () => {
    synth().resourceCountIs('AWS::IAM::Role', 0)
  })

  it('lets CI run commands only on instances tagged for this project', () => {
    synth('acme/airi-web').hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([Match.objectLike({
          Action: 'ssm:SendCommand',
          Condition: { StringEquals: { 'ssm:resourceTag/project': 'airi-web' } },
        })]),
      },
    })
  })

  it('trusts GitHub OIDC only for the main branch of the given repo', () => {
    synth('acme/airi-web').hasResourceProperties('AWS::IAM::Role', {
      AssumeRolePolicyDocument: {
        Statement: [Match.objectLike({
          Action: 'sts:AssumeRoleWithWebIdentity',
          Condition: {
            StringEquals: { 'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com' },
            StringLike: { 'token.actions.githubusercontent.com:sub': 'repo:acme/airi-web:ref:refs/heads/main' },
          },
        })],
      },
    })
  })

  it('reuses an existing OIDC provider instead of creating a second one', () => {
    const arn = 'arn:aws:iam::111111111111:oidc-provider/token.actions.githubusercontent.com'
    const template = synth('acme/airi-web', arn)
    template.resourceCountIs('Custom::AWSCDKOpenIdConnectProvider', 0)
    template.resourceCountIs('AWS::IAM::Role', 1)
  })
})

describe('readDeployConfig', () => {
  const BASE = { region: 'ap-southeast-1', publicUrl: 'https://airi-web.example.workers.dev' }
  const read = (context: Record<string, unknown>) => readDeployConfig(new App({ context }))

  it('applies defaults for optional values', () => {
    const config = read(BASE)
    expect(config).toMatchObject({ ...BASE, imageTag: 'bootstrap', instanceType: 't3.small' })
    expect(config.githubRepo).toBeUndefined()
  })

  it.each([undefined, ''])('rejects a missing region (%j)', (region) => {
    expect(() => read({ ...BASE, region })).toThrow(/region/)
  })

  it.each([undefined, '', 'http://airi.example.com', 'https://airi.example.com/app', 'airi.example.com'])(
    'rejects publicUrl that is not a bare https origin (%j)',
    (publicUrl) => {
      expect(() => read({ ...BASE, publicUrl })).toThrow(/publicUrl/)
    },
  )

  it.each(['acme', 'acme/airi web', 'https://github.com/acme/airi'])('rejects a malformed githubRepo (%j)', (githubRepo) => {
    expect(() => read({ ...BASE, githubRepo })).toThrow(/githubRepo/)
  })
})
