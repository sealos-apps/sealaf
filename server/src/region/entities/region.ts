import { ApiProperty } from '@nestjs/swagger'
import { ObjectId } from 'mongodb'

export enum ApplicationNamespaceMode {
  Fixed = 'fixed',
  AppId = 'appid',
}

export type RegionNamespaceConf = {
  mode: ApplicationNamespaceMode
  prefix: string
  fixed?: string
}

export type RegionClusterConf = {
  driver: string
  kubeconfig: string
  npmInstallFlags: string
  runtimeAffinity: any
}

export type RegionResourceBundleConf = {
  cpuRequestLimitRatio: number
  memoryRequestLimitRatio: number
}

export type RegionDatabaseConf = {
  driver: string
  connectionUri: string
  controlConnectionUri: string
  dedicatedDatabase: {
    enabled: boolean
  }
}

export type TLSConf = {
  enabled: boolean
  wildcardCertificateSecretName?: string
}

export type RegionGatewayConf = {
  driver: 'apisix' | 'nginx'
  runtimeDomain: string
  port: number
  tls: TLSConf
}

export type RegionStorageConf = {
  driver: string
  domain: string
  externalEndpoint: string
  internalEndpoint: string
  accessKey: string
  secretKey: string
  controlEndpoint: string
}

export type LogServerConf = {
  apiUrl: string
  secret: string
  databaseUrl: string
}

export type PrometheusConf = {
  apiUrl: string
}

export type DeployManifestTemplateKey =
  | 'database'
  | 'databaseOpsRequestStart'
  | 'databaseOpsRequestStop'
  | 'databaseOpsRequestRestart'
  | 'databaseOpsRequestVerticalScaling'
  | 'databaseOpsRequestHorizontalScaling'
  | 'databaseOpsRequestVolumeExpansion'

export type DeployManifestVersion = 'kb8' | 'kb9'

export type DeployManifestTemplates = Partial<
  Record<DeployManifestTemplateKey, string>
>

export type DeployManifest = DeployManifestTemplates & {
  defaultVersion?: DeployManifestVersion
  versions?: Partial<Record<DeployManifestVersion, DeployManifestTemplates>>
}

export class Region {
  @ApiProperty({ type: String })
  _id?: ObjectId

  @ApiProperty()
  name: string

  @ApiProperty()
  displayName: string

  clusterConf: RegionClusterConf
  bundleConf: RegionResourceBundleConf
  gatewayConf: RegionGatewayConf

  deployManifest: DeployManifest

  @ApiProperty()
  state: 'Active' | 'Inactive'

  @ApiProperty()
  createdAt: Date

  @ApiProperty()
  updatedAt: Date

  constructor(partial: Partial<Region>) {
    Object.assign(this, partial)
  }
}
