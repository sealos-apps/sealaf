import { Injectable, Logger } from '@nestjs/common'
import { Cron, CronExpression } from '@nestjs/schedule'
import * as assert from 'node:assert'
import { RegionService } from 'src/region/region.service'
import { RuntimeDomainService } from 'src/gateway/runtime-domain.service'
import { ServerConfig, TASK_LOCK_INIT_TIME } from 'src/constants'
import { SystemDatabase } from 'src/system-database'
import { TriggerService } from 'src/trigger/trigger.service'
import { FunctionService } from 'src/function/function.service'
import { ApplicationConfigurationService } from './configuration.service'
import { BundleService } from 'src/application/bundle.service'
import {
  Application,
  ApplicationPhase,
  ApplicationState,
} from './entities/application'
import { DomainPhase, DomainState } from 'src/gateway/entities/runtime-domain'
import { DedicatedDatabaseService } from 'src/database/dedicated-database/dedicated-database.service'
import { CloudBinBucketService } from 'src/storage/cloud-bin-bucket.service'
import { InstanceService } from 'src/instance/instance.service'
import { ClusterService } from 'src/region/cluster/cluster.service'

@Injectable()
export class ApplicationTaskService {
  readonly lockTimeout = 15 // in second
  private readonly logger = new Logger(ApplicationTaskService.name)

  constructor(
    private readonly regionService: RegionService,
    private readonly dedicatedDatabaseService: DedicatedDatabaseService,
    private readonly runtimeDomainService: RuntimeDomainService,
    private readonly triggerService: TriggerService,
    private readonly functionService: FunctionService,
    private readonly configurationService: ApplicationConfigurationService,
    private readonly bundleService: BundleService,
    private readonly cloudbinService: CloudBinBucketService,
    private readonly instanceService: InstanceService,
    private readonly clusterService: ClusterService,
  ) {}

  @Cron(CronExpression.EVERY_SECOND)
  async tick() {
    if (ServerConfig.DISABLED_APPLICATION_TASK) {
      return
    }

    // Phase `Creating` -> `Created`
    this.handleCreatingPhase().catch((err) => {
      this.logger.error(err)
      // eslint-disable-next-line no-console
      console.error(err)
    })

    // Phase `Deleting` -> `Deleted`
    this.handleDeletingPhase().catch((err) => {
      this.logger.error(err)
      // eslint-disable-next-line no-console
      console.error(err)
    })

    // State `Deleted`
    this.handleDeletedState().catch((err) => {
      this.logger.error(err)
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore
      console.error(err)
    })
  }

  /**
   * Phase `Creating`:
   * - create namespace
   * - create runtime domain
   * - create database & user
   * - move phase `Creating` to `Created`
   */
  async handleCreatingPhase() {
    const db = SystemDatabase.db

    const res = await db
      .collection<Application>('Application')
      .findOneAndUpdate(
        {
          state: { $ne: ApplicationState.Deleted },
          phase: ApplicationPhase.Creating,
          lockedAt: { $lt: new Date(Date.now() - 1000 * this.lockTimeout) },
        },
        { $set: { lockedAt: new Date() } },
        { sort: { lockedAt: 1, updatedAt: 1 }, returnDocument: 'after' },
      )

    if (!res.value) return

    const app = res.value
    const appid = app.appid

    this.logger.log(`handleCreatingPhase matched app ${appid}, locked it`)

    if (await this.isApplicationDeleting(appid)) return

    // get region by appid
    const region = await this.regionService.findByAppId(appid)
    assert(region, `Region ${region.name} not found`)

    // reconcile runtime domain
    let runtimeDomain = await this.runtimeDomainService.findOne(appid)
    if (!runtimeDomain) {
      if (await this.isApplicationDeleting(appid)) return
      this.logger.log(`Creating gateway for application ${appid}`)
      runtimeDomain = await this.runtimeDomainService.create(appid)

      if (await this.isApplicationDeleting(appid)) {
        await this.runtimeDomainService.deleteOne(appid)
        return
      }
    }

    // waiting resources' phase to be `Created`
    if (runtimeDomain?.phase !== DomainPhase.Created) {
      await this.unlock(appid)
      return
    }

    // update application phase to `Created`
    await db.collection<Application>('Application').updateOne(
      { _id: app._id, phase: ApplicationPhase.Creating },
      {
        $set: {
          phase: ApplicationPhase.Created,
          lockedAt: TASK_LOCK_INIT_TIME,
        },
      },
    )

    this.logger.log('app phase updated to `Created`: ' + app.appid)
  }

  /**
   * Phase `Deleting`:
   * - delete triggers (k8s cronjob)
   * - delete cloud functions
   * - delete policies
   * - delete application configuration
   * - delete application bundle
   * - delete website
   * - delete runtime domain
   * - delete bucket domains
   * - delete database (mongo db)
   * - delete namespace
   * - move phase `Deleting` to `Deleted`
   */
  async handleDeletingPhase() {
    const db = SystemDatabase.db

    const res = await db
      .collection<Application>('Application')
      .findOneAndUpdate(
        {
          state: ApplicationState.Deleted,
          phase: ApplicationPhase.Deleting,
          lockedAt: { $lt: new Date(Date.now() - 1000 * this.lockTimeout) },
        },
        { $set: { lockedAt: new Date() } },
        { sort: { lockedAt: 1, updatedAt: 1 }, returnDocument: 'after' },
      )

    if (!res.value) return

    // get region by appid
    const app = res.value
    const appid = app.appid
    const region = await this.regionService.findByAppId(appid)
    assert(region, `Region of application ${appid} not found`)
    const user = await this.clusterService.getUserByAppid(appid)
    assert(user, `User of application ${appid} not found`)

    // delete triggers
    const hadTriggers = await this.triggerService.count(appid)
    if (hadTriggers > 0) {
      await this.triggerService.removeAll(appid)
      return await this.unlock(appid)
    }

    // delete runtime domain
    const runtimeDomain = await this.runtimeDomainService.findOne(appid)
    if (runtimeDomain) {
      if (
        runtimeDomain.state !== DomainState.Deleted ||
        runtimeDomain.phase !== DomainPhase.Deleted
      ) {
        await this.runtimeDomainService.deleteOne(appid)
        return await this.unlock(appid)
      }
    }

    const hadRuntimeResources =
      await this.instanceService.removeRuntimeResources(appid, user.namespace)
    if (hadRuntimeResources) return await this.unlock(appid)

    // delete cloud functions
    const hadFunctions = await this.functionService.count(appid)
    if (hadFunctions > 0) {
      await this.functionService.removeAll(appid)
      return await this.unlock(appid)
    }

    // delete application configuration
    const hadConfigurations = await this.configurationService.count(appid)
    if (hadConfigurations > 0) {
      await this.configurationService.remove(appid)
      return await this.unlock(appid)
    }

    const dedicatedDatabase = await this.dedicatedDatabaseService.findOne(appid)
    if (dedicatedDatabase) {
      await this.dedicatedDatabaseService.remove(appid)
      return await this.unlock(appid)
    }

    // delete application bundle
    const bundle = await this.bundleService.findOne(appid)
    if (bundle) {
      await this.bundleService.deleteOne(appid)
      return await this.unlock(appid)
    }

    await this.cloudbinService.deleteCloudBinBucket(appid)

    // update phase to `Deleted`
    await db.collection<Application>('Application').updateOne(
      { _id: app._id, phase: ApplicationPhase.Deleting },
      {
        $set: {
          phase: ApplicationPhase.Deleted,
          lockedAt: TASK_LOCK_INIT_TIME,
        },
      },
    )

    this.logger.log('app phase updated to `Deleted`: ' + app.appid)
  }

  /**
   * State `Deleted`:
   * - move active phases to `Deleting`
   * - delete phase `Deleted` documents
   */
  async handleDeletedState() {
    const db = SystemDatabase.db

    await db.collection<Application>('Application').updateMany(
      {
        state: ApplicationState.Deleted,
        phase: {
          $in: [
            ApplicationPhase.Creating,
            ApplicationPhase.Created,
            ApplicationPhase.Starting,
            ApplicationPhase.Started,
            ApplicationPhase.Stopping,
            ApplicationPhase.Stopped,
          ],
        },
      },
      {
        $set: {
          phase: ApplicationPhase.Deleting,
          lockedAt: TASK_LOCK_INIT_TIME,
        },
      },
    )

    await db.collection<Application>('Application').deleteMany({
      state: ApplicationState.Deleted,
      phase: ApplicationPhase.Deleted,
    })
  }

  /**
   * Unlock application by appid
   */
  async unlock(appid: string) {
    const db = SystemDatabase.db
    await db.collection<Application>('Application').updateOne(
      { appid: appid },
      {
        $set: {
          lockedAt: new Date(Date.now() - 1000 * (this.lockTimeout + 1)),
        },
      },
    )
  }

  private async isApplicationDeleting(appid: string) {
    const app = await SystemDatabase.db
      .collection<Application>('Application')
      .findOne({ appid }, { projection: { state: 1, phase: 1 } })

    return (
      !app ||
      app.state === ApplicationState.Deleted ||
      app.phase === ApplicationPhase.Deleting ||
      app.phase === ApplicationPhase.Deleted
    )
  }
}
