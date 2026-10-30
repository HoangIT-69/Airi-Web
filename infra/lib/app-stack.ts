import { CfnOutput, Stack, type StackProps } from 'aws-cdk-lib'
import type { Construct } from 'constructs'
import { Network } from './constructs/network.js'
import { Server } from './constructs/server.js'

const AZ_SUFFIXES = ['a'] as const

export interface AppStackProps extends StackProps {
  readonly instanceType: string
  readonly imageTag: string
  readonly publicUrl: string
}

/** AWS side of AIRI web: one EC2 instance behind the Cloudflare Worker (see docs/infra). */
export class AppStack extends Stack {
  /** Fixed AZ so synth needs no AWS lookup (offline synth, tests, CI without lookup role). */
  override get availabilityZones(): string[] {
    return AZ_SUFFIXES.map(suffix => `${this.region}${suffix}`)
  }

  constructor(scope: Construct, id: string, props: AppStackProps) {
    super(scope, id, props)

    const { vpc } = new Network(this, 'Network')
    const server = new Server(this, 'Server', {
      vpc,
      instanceType: props.instanceType,
      imageTag: props.imageTag,
      publicUrl: props.publicUrl,
    })

    new CfnOutput(this, 'InstanceId', { value: server.instance.instanceId })
    new CfnOutput(this, 'OriginUrl', {
      value: server.originUrl,
      description: 'Set as ORIGIN_URL of the Cloudflare Worker',
    })
  }
}
