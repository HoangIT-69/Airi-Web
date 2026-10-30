import type { App } from 'aws-cdk-lib'

/** Prefix applied to every physical name, stack id and SSM path. */
export const APP_NAME = 'airi-web'
export const SSM_PREFIX = `/${APP_NAME}`

/** Plain-text parameters CDK owns (CloudFormation cannot create SecureString). */
export const SSM_PARAM_BUNDLE_URL = `${SSM_PREFIX}/deploy/bundle-url`
export const SSM_PARAM_IMAGE_TAG = `${SSM_PREFIX}/deploy/image-tag`
export const SSM_PARAM_PUBLIC_URL = `${SSM_PREFIX}/config/public-url`
/** SecureString parameters the operator creates once by hand (see docs/infra/architecture.md). */
export const SSM_SECURE_PATH = `${SSM_PREFIX}/secure`
export const SECURE_PARAM_NAMES = [
  'ORIGIN_SECRET',
  'AUTH_GOOGLE_CLIENT_ID',
  'AUTH_GOOGLE_CLIENT_SECRET',
  'AUTH_GITHUB_CLIENT_ID',
  'AUTH_GITHUB_CLIENT_SECRET',
] as const

export const IMAGE_SERVICES = ['api', 'auth'] as const
export const ECR_IMAGES_TO_KEEP = 5
export const HTTP_PORT = 80
export const HTTPS_PORT = 443
/** Free plan allows 30 GiB of EBS; root volume holds OS, images and Postgres data. */
export const ROOT_VOLUME_GIB = 30
export const SNAPSHOTS_TO_KEEP = 3
export const DEFAULT_INSTANCE_TYPE = 't3.small'
export const BOOTSTRAP_IMAGE_TAG = 'bootstrap'

export interface DeployConfig {
  readonly account?: string
  readonly region: string
  /** Public URL users open, i.e. the Cloudflare Worker (e.g. https://airi-web.<sub>.workers.dev). */
  readonly publicUrl: string
  /** ECR image tag for api/auth (CI passes the AIRI commit SHA). */
  readonly imageTag: string
  readonly instanceType: string
  /** `owner/repo` allowed to assume the CI deploy role via GitHub OIDC; omit to skip the role. */
  readonly githubRepo?: string
  readonly githubOidcProviderArn?: string
  /** GitHub Actions environment the deploy job runs in; changes the OIDC `sub` claim. */
  readonly githubEnvironment?: string
  /**
   * Repo part of the OIDC `sub` when GitHub sends immutable IDs, e.g. `owner@123/repo@456`.
   * Defaults to githubRepo (legacy `owner/repo` subjects).
   */
  readonly githubOidcSubjectRepo?: string
}

function readString(app: App, key: string): string | undefined {
  const value: unknown = app.node.tryGetContext(key)
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function requireString(app: App, key: string): string {
  const value = readString(app, key)
  if (!value)
    throw new Error(`CDK context "${key}" is required`)
  return value
}

export function readDeployConfig(app: App): DeployConfig {
  const publicUrl = requireString(app, 'publicUrl')
  if (!/^https:\/\/[^/\s]+$/.test(publicUrl))
    throw new Error(`CDK context "publicUrl" must be an https origin without path, got ${publicUrl}`)

  const githubRepo = readString(app, 'githubRepo')
  if (githubRepo && !/^[\w.-]+\/[\w.-]+$/.test(githubRepo))
    throw new Error(`CDK context "githubRepo" must look like owner/repo, got ${githubRepo}`)

  return {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: requireString(app, 'region'),
    publicUrl,
    imageTag: readString(app, 'imageTag') ?? BOOTSTRAP_IMAGE_TAG,
    instanceType: readString(app, 'instanceType') ?? DEFAULT_INSTANCE_TYPE,
    githubRepo,
    githubOidcProviderArn: readString(app, 'githubOidcProviderArn'),
    githubEnvironment: readString(app, 'githubEnvironment'),
    githubOidcSubjectRepo: readString(app, 'githubOidcSubjectRepo'),
  }
}
