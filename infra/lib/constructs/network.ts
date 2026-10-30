import * as ec2 from 'aws-cdk-lib/aws-ec2'
import { Construct } from 'constructs'

const SUBNET_CIDR_MASK = 24

/**
 * Public subnet only: the single instance gets its egress from its own public IP,
 * so there is no NAT gateway (the largest fixed cost of a private-subnet design).
 */
export class Network extends Construct {
  readonly vpc: ec2.Vpc

  constructor(scope: Construct, id: string) {
    super(scope, id)

    this.vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 1,
      natGateways: 0,
      subnetConfiguration: [{ name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: SUBNET_CIDR_MASK }],
    })
  }
}
