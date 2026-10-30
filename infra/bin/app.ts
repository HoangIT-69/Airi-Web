import { App, Tags } from 'aws-cdk-lib'
import { AppStack } from '../lib/app-stack.js'
import { APP_NAME, readDeployConfig } from '../lib/config.js'
import { RegistryStack } from '../lib/registry-stack.js'

const app = new App()
const config = readDeployConfig(app)
const env = { account: config.account, region: config.region }

const registry = new RegistryStack(app, `${APP_NAME}-registry`, {
  env,
  githubRepo: config.githubRepo,
  githubOidcProviderArn: config.githubOidcProviderArn,
  githubEnvironment: config.githubEnvironment,
})

const appStack = new AppStack(app, `${APP_NAME}-app`, {
  env,
  instanceType: config.instanceType,
  imageTag: config.imageTag,
  publicUrl: config.publicUrl,
})
appStack.addStackDependency(registry)

Tags.of(app).add('project', APP_NAME)
