import { Injectable, Logger } from '@nestjs/common'
import { ServerConfig } from '../constants'
import { SystemDatabase } from 'src/system-database'
import {
  DeployManifest,
  DeployManifestTemplates,
  Region,
} from 'src/region/entities/region'
import { Runtime } from 'src/application/entities/runtime'
import {
  ResourceOption,
  ResourceBundle,
  ResourceType,
} from 'src/billing/entities/resource'
import { Setting, SettingKey } from 'src/setting/entities/setting'
import * as path from 'path'
import { readFileSync, readdirSync } from 'node:fs'
import { User } from 'src/user/entities/user'
import { Application } from 'src/application/entities/application'
import { ApplicationConfiguration } from 'src/application/entities/application-configuration'
import { CloudFunction } from 'src/function/entities/cloud-function'
import { CloudFunctionHistory } from 'src/function/entities/cloud-function-history'
import { CronTrigger } from 'src/trigger/entities/cron-trigger'
import { PersonalAccessToken } from 'src/user/entities/pat'
import { RuntimeDomain } from 'src/gateway/entities/runtime-domain'
import { ApplicationBundle } from 'src/application/entities/application-bundle'
import { DedicatedDatabase } from 'src/database/entities/dedicated-database'

@Injectable()
export class InitializerService {
  private readonly logger = new Logger(InitializerService.name)
  private readonly db = SystemDatabase.db

  private readDeployManifestTemplates(
    basePath: string,
    dir: string,
  ): DeployManifestTemplates {
    const dirPath = path.resolve(basePath, dir)
    const files = readdirSync(dirPath)

    return files.reduce((prev, file) => {
      const key = file.slice(0, -path.extname(file).length)
      const value = readFileSync(path.resolve(dirPath, file), 'utf8')
      prev[key] = value
      return prev
    }, {})
  }

  private readDeployManifest(): DeployManifest {
    const basePath = path.resolve(__dirname, './deploy-manifest')
    const defaultVersion = ServerConfig.KUBEBLOCKS_TEMPLATE_VERSION
    const common = this.readDeployManifestTemplates(basePath, 'common')
    const versions = {
      kb8: this.readDeployManifestTemplates(basePath, 'kb8'),
      kb9: this.readDeployManifestTemplates(basePath, 'kb9'),
    }

    return {
      ...common,
      database: versions[defaultVersion]?.database,
      defaultVersion,
      versions,
    }
  }

  async init() {
    await this.createDatabaseIndexes()
    await this.createDefaultRegion()
    await this.createDefaultRuntime()
    await this.createDefaultResourceOptions()
    await this.createDefaultResourceBundles()
    await this.createDefaultSettings()
  }

  async createDefaultRegion() {
    // check if exists
    const existed = await this.db.collection<Region>('Region').countDocuments()
    if (existed) {
      this.logger.debug('region already exists')
      return
    }

    const manifest = this.readDeployManifest()

    const res = await this.db.collection<Region>('Region').insertOne({
      name: 'default',
      displayName: 'Default',
      clusterConf: {
        driver: 'kubernetes',
        kubeconfig: null,
        npmInstallFlags: '',
        runtimeAffinity: {},
      },
      bundleConf: {
        cpuRequestLimitRatio: 0.1,
        memoryRequestLimitRatio: 0.5,
      },
      gatewayConf: {
        driver: 'nginx',
        runtimeDomain: ServerConfig.DEFAULT_REGION_RUNTIME_DOMAIN,
        port: 80,
        tls: {
          enabled: ServerConfig.DEFAULT_REGION_TLS_ENABLED,
          wildcardCertificateSecretName:
            ServerConfig.DEFAULT_REGION_TLS_WILDCARD_CERTIFICATE_SECRET_NAME,
        },
      },
      deployManifest: manifest,
      updatedAt: new Date(),
      createdAt: new Date(),
      state: 'Active',
    })

    this.logger.verbose(`Created default region`)
    return res
  }

  async createDefaultRuntime() {
    // check if exists
    const existed = await this.db
      .collection<Runtime>('Runtime')
      .countDocuments()
    if (existed) {
      this.logger.debug('default runtime already exists')
      return
    }

    // create default runtime
    const res = await this.db.collection<Runtime>('Runtime').insertOne({
      name: 'node',
      type: 'node:laf',
      image: {
        main: ServerConfig.DEFAULT_RUNTIME_IMAGE.image.main,
        init: ServerConfig.DEFAULT_RUNTIME_IMAGE.image.init,
      },
      version: ServerConfig.DEFAULT_RUNTIME_IMAGE.version,
      latest: true,
      state: 'Active',
    })

    this.logger.verbose('Created default runtime')
    return res
  }

  async createDefaultResourceOptions() {
    // check if exists
    const existed = await this.db
      .collection<ResourceOption>('ResourceOption')
      .countDocuments()
    if (existed) {
      this.logger.debug('default resource options already exists')
      return
    }

    // get default region
    const region = await this.db.collection<Region>('Region').findOne({})

    // create default resource options
    await this.db.collection<ResourceOption>('ResourceOption').insertMany([
      {
        regionId: region._id,
        type: ResourceType.CPU,
        price: 0.0,
        specs: [
          { label: '0.2 Core', value: 200 },
          { label: '0.5 Core', value: 500 },
          { label: '1 Core', value: 1000 },
          { label: '2 Core', value: 2000 },
        ],
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        regionId: region._id,
        type: ResourceType.Memory,
        price: 0.0,
        specs: [
          { label: '256 MB', value: 256 },
          { label: '512 MB', value: 512 },
          { label: '1 GB', value: 1024 },
          { label: '2 GB', value: 2048 },
          { label: '4 GB', value: 4096 },
        ],
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        regionId: region._id,
        type: ResourceType.NetworkTraffic,
        price: 0.8,
        specs: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        regionId: region._id,
        type: ResourceType.DedicatedDatabaseCPU,
        price: 0.0,
        specs: [
          { label: '0.2 Core', value: 200 },
          { label: '0.5 Core', value: 500 },
          { label: '1 Core', value: 1000 },
          { label: '2 Core', value: 2000 },
        ],
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        regionId: region._id,
        type: ResourceType.DedicatedDatabaseMemory,
        price: 0.0,
        specs: [
          { label: '256 MB', value: 256 },
          { label: '512 MB', value: 512 },
          { label: '1 GB', value: 1024 },
          { label: '2 GB', value: 2048 },
          { label: '4 GB', value: 4096 },
        ],
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        regionId: region._id,
        type: ResourceType.DedicatedDatabaseCapacity,
        price: 0.0,
        specs: [
          { label: '1 GB', value: 1024 },
          { label: '4 GB', value: 4096 },
          { label: '16 GB', value: 16384 },
          { label: '64 GB', value: 65536 },
          { label: '256 GB', value: 262144 },
        ],
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        regionId: region._id,
        type: ResourceType.DedicatedDatabaseReplicas,
        price: 0.0,
        specs: [
          { label: '1', value: 1 },
          { label: '3', value: 3 },
          { label: '5', value: 5 },
          { label: '7', value: 7 },
          { label: '9', value: 9 },
        ],
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ])

    this.logger.verbose('Created default resource options')
  }

  async createDefaultResourceBundles() {
    // check if exists
    const existed = await this.db
      .collection<ResourceBundle>('ResourceBundle')
      .countDocuments()

    if (existed) {
      this.logger.debug('default resource templates already exists')
      return
    }

    // get default region
    const region = await this.db.collection<Region>('Region').findOne({})

    // create default resource templates
    await this.db.collection<ResourceBundle>('ResourceBundle').insertMany([
      {
        regionId: region._id,
        name: 'trial',
        displayName: 'Trial',
        spec: {
          [ResourceType.CPU]: { value: 200 },
          [ResourceType.Memory]: { value: 256 },
          [ResourceType.NetworkTraffic]: { value: 0 },
          [ResourceType.DedicatedDatabaseCPU]: { value: 200 },
          [ResourceType.DedicatedDatabaseMemory]: { value: 256 },
          [ResourceType.DedicatedDatabaseCapacity]: { value: 1024 },
          [ResourceType.DedicatedDatabaseReplicas]: { value: 1 },
        },
        enableFreeTier: false,
        limitCountOfFreeTierPerUser: 20,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        regionId: region._id,
        name: 'lite',
        displayName: 'Lite',
        spec: {
          [ResourceType.CPU]: { value: 500 },
          [ResourceType.Memory]: { value: 512 },
          [ResourceType.NetworkTraffic]: { value: 0 },
          [ResourceType.DedicatedDatabaseCPU]: { value: 500 },
          [ResourceType.DedicatedDatabaseMemory]: { value: 512 },
          [ResourceType.DedicatedDatabaseCapacity]: { value: 4096 },
          [ResourceType.DedicatedDatabaseReplicas]: { value: 3 },
        },
        enableFreeTier: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        regionId: region._id,
        name: 'standard',
        displayName: 'Standard',
        spec: {
          [ResourceType.CPU]: { value: 1000 },
          [ResourceType.Memory]: { value: 2048 },
          [ResourceType.NetworkTraffic]: { value: 0 },
          [ResourceType.DedicatedDatabaseCPU]: { value: 1000 },
          [ResourceType.DedicatedDatabaseMemory]: { value: 2048 },
          [ResourceType.DedicatedDatabaseCapacity]: { value: 16384 },
          [ResourceType.DedicatedDatabaseReplicas]: { value: 5 },
        },
        enableFreeTier: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        regionId: region._id,
        name: 'pro',
        displayName: 'Pro',
        spec: {
          [ResourceType.CPU]: { value: 2000 },
          [ResourceType.Memory]: { value: 4096 },
          [ResourceType.NetworkTraffic]: { value: 0 },
          [ResourceType.DedicatedDatabaseCPU]: { value: 2000 },
          [ResourceType.DedicatedDatabaseMemory]: { value: 4096 },
          [ResourceType.DedicatedDatabaseCapacity]: { value: 65536 },
          [ResourceType.DedicatedDatabaseReplicas]: { value: 7 },
        },
        enableFreeTier: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ])

    this.logger.verbose('Created default resource templates')
  }

  // create default settings
  async createDefaultSettings() {
    // check if exists
    const existed = await this.db
      .collection<Setting>('Setting')
      .countDocuments()

    if (existed) {
      this.logger.debug('default settings already exists')
      return
    }

    await this.db.collection<Setting>('Setting').insertMany([
      {
        public: true,
        key: SettingKey.AiPilotUrl,
        value: 'https://htr4n1.laf.run/laf-gpt',
        desc: 'ai pilot url',
      },
      {
        public: true,
        key: SettingKey.LafForumUrl,
        value: 'https://forum.laf.run',
        desc: 'laf forum url',
      },
      {
        public: true,
        key: SettingKey.LafBusinessUrl,
        value: 'https://www.wenjuan.com/s/I36ZNbl',
        desc: 'laf business url',
      },
      {
        public: true,
        key: SettingKey.LafDiscordUrl,
        value:
          'https://discord.com/channels/1061659231599738901/1098516786170839050',
        desc: 'laf discord url',
      },
      {
        public: true,
        key: SettingKey.LafWeChatUrl,
        value: 'https://w4mci7-images.oss.laf.run/wechat.png',
        desc: 'laf wechat url',
      },
      {
        public: true,
        key: SettingKey.LafAboutUsUrl,
        value: 'https://sealos.run/company/',
        desc: 'laf about us url',
      },
      {
        public: true,
        key: SettingKey.LafDocUrl,
        value: 'https://doc.laf.run/zh/',
        desc: 'laf doc site url',
      },
      {
        public: false,
        key: SettingKey.AppCreateTimeOut,
        value: '15',
        desc: 'timeout for application creation in minutes',
      },
    ])

    this.logger.verbose('Created default settings')
  }

  async createDatabaseIndexes() {
    const existed = await this.db.collection<Region>('Region').countDocuments()
    if (existed) {
      return
    }
    await this.db.collection<User>('User').createIndex(
      {
        namespace: 1,
      },
      {
        unique: true,
      },
    )
    await this.db.collection<Application>('Application').createIndex(
      {
        appid: 1,
      },
      {
        unique: true,
      },
    )
    await this.db.collection<Application>('Application').createIndex({
      createdBy: 1,
    })
    await this.db
      .collection<ApplicationBundle>('ApplicationBundle')
      .createIndex(
        {
          appid: 1,
        },
        {
          unique: true,
        },
      )
    await this.db
      .collection<ApplicationConfiguration>('ApplicationConfiguration')
      .createIndex(
        {
          appid: 1,
        },
        {
          unique: true,
        },
      )
    await this.db.collection<CloudFunction>('CloudFunction').createIndex(
      {
        appid: 1,
        name: 1,
      },
      {
        unique: true,
      },
    )
    await this.db
      .collection<CloudFunctionHistory>('CloudFunctionHistory')
      .createIndex({
        appid: 1,
        functionId: 1,
      })
    await this.db
      .collection<CloudFunctionHistory>('CloudFunctionHistory')
      .createIndex({
        createdAt: -1,
      })
    await this.db.collection<CronTrigger>('CronTrigger').createIndex({
      appid: 1,
    })
    await this.db
      .collection<PersonalAccessToken>('PersonalAccessToken')
      .createIndex(
        {
          token: 1,
        },
        {
          unique: true,
        },
      )
    await this.db.collection<Region>('Region').createIndex(
      {
        name: 1,
      },
      {
        unique: true,
      },
    )
    await this.db.collection<Runtime>('Runtime').createIndex(
      {
        name: 1,
      },
      {
        unique: true,
      },
    )
    await this.db.collection<RuntimeDomain>('RuntimeDomain').createIndex(
      {
        appid: 1,
      },
      {
        unique: true,
      },
    )
    await this.db.collection<RuntimeDomain>('RuntimeDomain').createIndex(
      {
        domain: 1,
      },
      {
        unique: true,
      },
    )
    await this.db
      .collection<DedicatedDatabase>('DedicatedDatabase')
      .createIndex(
        {
          appid: 1,
        },
        {
          unique: true,
        },
      )
  }
}
