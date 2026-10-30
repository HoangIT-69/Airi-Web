import { CfnOutput, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib'
import * as ecr from 'aws-cdk-lib/aws-ecr'
import * as iam from 'aws-cdk-lib/aws-iam'
import type { Construct } from 'constructs'
import { APP_NAME, ECR_IMAGES_TO_KEEP, IMAGE_SERVICES } from './config.js'

const GITHUB_OIDC_URL = 'https://token.actions.githubusercontent.com'
const GITHUB_OIDC_AUDIENCE = 'sts.amazonaws.com'
const CI_ROLE_NAME = `${APP_NAME}-github-deploy`
/** Default qualifier created by `cdk bootstrap`. */
const CDK_BOOTSTRAP_QUALIFIER = 'hnb659fds'

export interface RegistryStackProps extends StackProps {
  /** `owner/repo`; when set, a GitHub OIDC deploy role is created (no long-lived keys). */
  readonly githubRepo?: string
  /** Reuse an existing account-wide GitHub OIDC provider instead of creating one. */
  readonly githubOidcProviderArn?: string
  /**
   * When the job declares `environment:`, GitHub sets the OIDC subject to
   * `repo:<repo>:environment:<name>` instead of the branch ref.
   */
  readonly githubEnvironment?: string
}

/** Tag every app resource carries (bin/app.ts); scopes the CI role's SSM access to our instance. */
const PROJECT_TAG_KEY = 'project'

/** Long-lived resources CI needs before the app stack can deploy: image repos and the deploy role. */
export class RegistryStack extends Stack {
  readonly repositories: ecr.Repository[]

  constructor(scope: Construct, id: string, props: RegistryStackProps) {
    super(scope, id, props)

    this.repositories = IMAGE_SERVICES.map(name => new ecr.Repository(this, `${name}Repo`, {
      repositoryName: `${APP_NAME}/${name}`,
      imageScanOnPush: true,
      imageTagMutability: ecr.TagMutability.IMMUTABLE,
      encryption: ecr.RepositoryEncryption.AES_256,
      lifecycleRules: [{ maxImageCount: ECR_IMAGES_TO_KEEP }],
      removalPolicy: RemovalPolicy.RETAIN,
    }))

    if (props.githubRepo)
      this.createCiRole(props.githubRepo, props.githubOidcProviderArn, props.githubEnvironment)
  }

  private createCiRole(githubRepo: string, providerArn?: string, environment?: string): void {
    const provider = providerArn
      ? iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(this, 'GithubOidc', providerArn)
      : new iam.OpenIdConnectProvider(this, 'GithubOidc', { url: GITHUB_OIDC_URL, clientIds: [GITHUB_OIDC_AUDIENCE] })

    const subjectScope = environment ? `environment:${environment}` : 'ref:refs/heads/main'
    const role = new iam.Role(this, 'CiRole', {
      roleName: CI_ROLE_NAME,
      description: `GitHub Actions deploy role for ${githubRepo} (${subjectScope})`,
      assumedBy: new iam.WebIdentityPrincipal(provider.openIdConnectProviderArn, {
        StringEquals: {
          'token.actions.githubusercontent.com:aud': GITHUB_OIDC_AUDIENCE,
          'token.actions.githubusercontent.com:sub': `repo:${githubRepo}:${subjectScope}`,
        },
      }),
    })

    for (const repository of this.repositories)
      repository.grantPullPush(role)
    role.addToPolicy(new iam.PolicyStatement({
      actions: ['sts:AssumeRole'],
      resources: [`arn:${this.partition}:iam::${this.account}:role/cdk-${CDK_BOOTSTRAP_QUALIFIER}-*`],
    }))
    role.addToPolicy(new iam.PolicyStatement({
      actions: ['cloudformation:DescribeStacks'],
      resources: [`arn:${this.partition}:cloudformation:${this.region}:${this.account}:stack/${APP_NAME}-*/*`],
    }))

    // Run deploy.sh on the instance through SSM — no SSH port, no key pair.
    role.addToPolicy(new iam.PolicyStatement({
      actions: ['ssm:SendCommand'],
      resources: [`arn:${this.partition}:ec2:${this.region}:${this.account}:instance/*`],
      conditions: { StringEquals: { [`ssm:resourceTag/${PROJECT_TAG_KEY}`]: APP_NAME } },
    }))
    role.addToPolicy(new iam.PolicyStatement({
      actions: ['ssm:SendCommand'],
      resources: [`arn:${this.partition}:ssm:${this.region}::document/AWS-RunShellScript`],
    }))
    role.addToPolicy(new iam.PolicyStatement({
      actions: ['ssm:GetCommandInvocation'],
      resources: ['*'],
    }))

    new CfnOutput(this, 'CiRoleArn', { value: role.roleArn })
  }
}
