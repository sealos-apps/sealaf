import { Cron, CronExpression } from '@nestjs/schedule'
import { SystemDatabase } from 'src/system-database'
import {
  DedicatedDatabase,
  DedicatedDatabasePhase,
  DedicatedDatabaseState,
} from '../entities/dedicated-database'
import { DedicatedDatabaseService } from './dedicated-database.service'
import { ServerConfig, TASK_LOCK_INIT_TIME } from 'src/constants'
import { Injectable, Logger } from '@nestjs/common'
import { RegionService } from 'src/region/region.service'
import { ClusterService } from 'src/region/cluster/cluster.service'
import { formatK8sErrorAsJson } from 'src/utils/k8s-error'
import {
  Application,
  ApplicationPhase,
  ApplicationState,
} from 'src/application/entities/application'

@Injectable()
export class DedicatedDatabaseTaskService {
  private readonly logger = new Logger(DedicatedDatabaseTaskService.name)
  private readonly lockTimeout = 15 // in seconds
  private readonly db = SystemDatabase.db

  constructor(
    private readonly regionService: RegionService,
    private readonly clusterService: ClusterService,
    private readonly dbService: DedicatedDatabaseService,
  ) {}

  @Cron(CronExpression.EVERY_SECOND)
  async tick() {
    if (ServerConfig.DISABLED_INSTANCE_TASK) {
      return
    }

    this.handleDeletingPhase().catch((err) => {
      this.logger.error(err)
    })
    this.handleStoppingPhase().catch((err) => {
      this.logger.error(err)
    })
    this.handleStartingPhase().catch((err) => {
      this.logger.error(err)
    })
    this.handleDeletedState().catch((err) => {
      this.logger.error(err)
    })
    this.handleStoppedState().catch((err) => {
      this.logger.error(err)
    })
    this.handleRestartingState().catch((err) => {
      this.logger.error(err)
    })
    this.handleRunningState().catch((err) => {
      this.logger.error(err)
    })
    this.handleUpdatingState().catch((err) => {
      this.logger.error(err)
    })
  }

  async handleStartingPhase() {
    const res = await this.db
      .collection<DedicatedDatabase>('DedicatedDatabase')
      .findOneAndUpdate(
        {
          state: DedicatedDatabaseState.Running,
          phase: DedicatedDatabasePhase.Starting,
          lockedAt: { $lt: new Date(Date.now() - this.lockTimeout * 1000) },
        },
        { $set: { lockedAt: new Date() } },
        { sort: { lockedAt: 1, updatedAt: 1 }, returnDocument: 'after' },
      )

    if (!res.value) return
    const data = res.value
    const appid = data.appid
    if (await this.isDeleting(appid)) return

    const region = await this.regionService.findByAppId(appid)
    const user = await this.clusterService.getUserByAppid(appid)
    const manifest = await this.dbService.getDeployManifest(region, user, appid)

    const waitingTime = Date.now() - data.updatedAt.getTime()

    // create dedicated database
    if (!manifest) {
      if (await this.isDeleting(appid)) return
      try {
        await this.dbService.applyDeployManifest(region, user, appid)
      } catch (error) {
        this.logger.error(
          `apply dedicated database ${appid} yaml error:\n${formatK8sErrorAsJson(
            error,
          )}`,
        )
      }
      await this.relock(appid, waitingTime)
      return
    }

    // Wait for KubeBlock controller to initialize if Cluster phase is empty or not initialized
    if (!manifest.status?.phase || manifest.status.phase === '') {
      this.logger.debug(
        `Cluster ${appid} phase is not initialized yet, waiting...`,
      )
      await this.relock(appid, waitingTime)
      return
    }

    if (manifest.status?.phase === 'Creating') {
      await this.relock(appid, waitingTime)
      return
    }

    // start dedicated database
    if (manifest.status?.phase !== 'Running') {
      const OpsRequestManifest =
        await this.dbService.getKubeBlockOpsRequestManifest(
          region,
          user,
          appid,
          'start',
        )

      if (OpsRequestManifest) {
        await this.relock(appid, waitingTime)
        return
      }

      if (await this.isDeleting(appid)) return
      try {
        await this.dbService.applyKubeBlockOpsRequestManifest(
          region,
          user,
          appid,
          'start',
        )
      } catch (error) {
        this.logger.error(
          `apply dedicated database ops request start ${appid} yaml error:\n${formatK8sErrorAsJson(
            error,
          )}`,
        )
      }

      await this.relock(appid, waitingTime)
      return
    }

    const connectionOk = await this.dbService.databaseConnectionIsOk(appid)
    if (!connectionOk) {
      await this.relock(appid, waitingTime)
      return
    }

    if (await this.isDeleting(appid)) return

    await this.dbService.deleteKubeBlockOpsManifest(
      region,
      user,
      appid,
      'start',
    )

    await this.db.collection<DedicatedDatabase>('DedicatedDatabase').updateOne(
      {
        appid,
        state: DedicatedDatabaseState.Running,
        phase: DedicatedDatabasePhase.Starting,
      },
      {
        $set: {
          state: DedicatedDatabaseState.Running,
          phase: DedicatedDatabasePhase.Started,
          lockedAt: TASK_LOCK_INIT_TIME,
          updatedAt: new Date(),
        },
      },
    )

    this.logger.debug(`dedicated database ${appid} updated to phase started`)
  }

  async handleDeletingPhase() {
    const res = await this.db
      .collection<DedicatedDatabase>('DedicatedDatabase')
      .findOneAndUpdate(
        {
          state: DedicatedDatabaseState.Deleted,
          phase: DedicatedDatabasePhase.Deleting,
          lockedAt: {
            $lt: new Date(Date.now() - this.lockTimeout * 1000),
          },
        },
        { $set: { lockedAt: new Date() } },
        { sort: { lockedAt: 1, updatedAt: 1 }, returnDocument: 'after' },
      )

    if (!res.value) return
    const data = res.value
    const appid = data.appid

    const waitingTime = Date.now() - data.updatedAt.getTime()

    const region = await this.regionService.findByAppId(appid)
    const user = await this.clusterService.getUserByAppid(appid)
    const manifest = await this.dbService.getDeployManifest(region, user, appid)

    if (manifest) {
      await this.dbService.deleteDeployManifest(region, user, appid)
      await this.relock(appid, waitingTime)
      return
    }

    await this.db.collection<DedicatedDatabase>('DedicatedDatabase').updateOne(
      {
        appid,
        state: DedicatedDatabaseState.Deleted,
        phase: DedicatedDatabasePhase.Deleting,
      },
      {
        $set: {
          phase: DedicatedDatabasePhase.Deleted,
          lockedAt: TASK_LOCK_INIT_TIME,
          updatedAt: new Date(),
        },
      },
    )
  }

  async handleStoppingPhase() {
    const res = await this.db
      .collection<DedicatedDatabase>('DedicatedDatabase')
      .findOneAndUpdate(
        {
          state: DedicatedDatabaseState.Stopped,
          phase: DedicatedDatabasePhase.Stopping,
          lockedAt: {
            $lt: new Date(Date.now() - this.lockTimeout * 1000),
          },
        },
        {
          $set: {
            lockedAt: new Date(),
          },
        },
      )

    if (!res.value) return
    const data = res.value
    const appid = data.appid
    if (await this.isDeleting(appid)) return

    const region = await this.regionService.findByAppId(appid)
    const user = await this.clusterService.getUserByAppid(appid)
    const waitingTime = Date.now() - data.updatedAt.getTime()

    const manifest = await this.dbService.getDeployManifest(region, user, appid)

    if (!manifest) {
      this.logger.warn(`Deploy manifest not found for ${appid}, skip stopping`)
      await this.db
        .collection<DedicatedDatabase>('DedicatedDatabase')
        .updateOne(
          {
            appid,
            state: DedicatedDatabaseState.Stopped,
            phase: DedicatedDatabasePhase.Stopping,
          },
          {
            $set: {
              state: DedicatedDatabaseState.Stopped,
              phase: DedicatedDatabasePhase.Stopped,
              lockedAt: TASK_LOCK_INIT_TIME,
              updatedAt: new Date(),
            },
          },
        )
      this.logger.debug(
        `update dedicated database ${appid} state to stopped,note: ddb manifest not found`,
      )

      return
    }

    if (manifest.status?.phase !== 'Stopped') {
      const OpsRequestManifest =
        await this.dbService.getKubeBlockOpsRequestManifest(
          region,
          user,
          appid,
          'stop',
        )

      if (OpsRequestManifest) {
        await this.relock(appid, waitingTime)
        return
      }

      if (await this.isDeleting(appid)) return
      try {
        await this.dbService.applyKubeBlockOpsRequestManifest(
          region,
          user,
          appid,
          'stop',
        )
      } catch (error) {
        this.logger.error(
          `apply dedicated database ops request stop ${appid} yaml error:\n${formatK8sErrorAsJson(
            error,
          )}`,
        )
      }

      await this.relock(appid, waitingTime)
      return
    }

    await this.dbService.deleteKubeBlockOpsManifest(region, user, appid, 'stop')

    await this.db.collection<DedicatedDatabase>('DedicatedDatabase').updateOne(
      {
        appid: data.appid,
        state: DedicatedDatabaseState.Stopped,
        phase: DedicatedDatabasePhase.Stopping,
      },
      {
        $set: {
          phase: DedicatedDatabasePhase.Stopped,
          lockedAt: TASK_LOCK_INIT_TIME,
          updatedAt: new Date(),
        },
      },
    )

    this.logger.log(`dedicated database ${appid} updated to phase Stopped`)
  }

  async handleDeletedState() {
    const db = SystemDatabase.db

    await db.collection<DedicatedDatabase>('DedicatedDatabase').updateMany(
      {
        state: DedicatedDatabaseState.Deleted,
        phase: {
          $in: [
            DedicatedDatabasePhase.Starting,
            DedicatedDatabasePhase.Started,
            DedicatedDatabasePhase.Stopping,
            DedicatedDatabasePhase.Stopped,
          ],
        },
      },
      {
        $set: {
          phase: DedicatedDatabasePhase.Deleting,
          lockedAt: TASK_LOCK_INIT_TIME,
        },
      },
    )

    await db.collection<DedicatedDatabase>('DedicatedDatabase').deleteMany({
      state: DedicatedDatabaseState.Deleted,
      phase: DedicatedDatabasePhase.Deleted,
    })
  }

  async handleStoppedState() {
    const db = SystemDatabase.db

    await db.collection<DedicatedDatabase>('DedicatedDatabase').updateMany(
      {
        state: DedicatedDatabaseState.Stopped,
        phase: {
          $in: [DedicatedDatabasePhase.Started],
        },
      },
      {
        $set: {
          phase: DedicatedDatabasePhase.Stopping,
          lockedAt: TASK_LOCK_INIT_TIME,
        },
      },
    )
  }

  async handleRunningState() {
    const db = SystemDatabase.db

    await db.collection<DedicatedDatabase>('DedicatedDatabase').updateMany(
      {
        state: DedicatedDatabaseState.Running,
        phase: {
          $in: [DedicatedDatabasePhase.Stopped],
        },
      },
      {
        $set: {
          phase: DedicatedDatabasePhase.Starting,
          lockedAt: TASK_LOCK_INIT_TIME,
        },
      },
    )
  }

  async handleRestartingState() {
    const db = SystemDatabase.db

    const res = await db
      .collection<DedicatedDatabase>('DedicatedDatabase')
      .findOneAndUpdate(
        {
          state: DedicatedDatabaseState.Restarting,
          phase: DedicatedDatabasePhase.Started,
          lockedAt: { $lt: new Date(Date.now() - 1000 * this.lockTimeout) },
        },
        { $set: { lockedAt: new Date() } },
        { sort: { lockedAt: 1, updatedAt: 1 }, returnDocument: 'after' },
      )

    if (!res.value) return
    const ddb = res.value
    const waitingTime = Date.now() - ddb.updatedAt.getTime()

    const appid = ddb.appid
    if (await this.isDeleting(appid)) return

    const region = await this.regionService.findByAppId(appid)
    const user = await this.clusterService.getUserByAppid(appid)

    const isDeployManifestChanged =
      await this.dbService.isDeployManifestChanged(region, user, appid)

    if (isDeployManifestChanged) {
      await this.db
        .collection<DedicatedDatabase>('DedicatedDatabase')
        .updateOne(
          {
            appid,
            state: DedicatedDatabaseState.Restarting,
            phase: DedicatedDatabasePhase.Started,
          },
          {
            $set: {
              state: DedicatedDatabaseState.Updating,
              phase: DedicatedDatabasePhase.Started,
              lockedAt: TASK_LOCK_INIT_TIME,
              updatedAt: new Date(),
            },
          },
        )
      return
    }

    if (await this.isDeleting(appid)) return

    const OpsRequestManifest =
      await this.dbService.getKubeBlockOpsRequestManifest(
        region,
        user,
        appid,
        'restart',
      )

    if (!OpsRequestManifest) {
      if (await this.isDeleting(appid)) return
      try {
        await this.dbService.applyKubeBlockOpsRequestManifest(
          region,
          user,
          appid,
          'restart',
        )
      } catch (error) {
        this.logger.error(
          `apply dedicated database restart ${appid} yaml error:\n${formatK8sErrorAsJson(
            error,
          )}`,
        )
      }
      await this.relock(appid, waitingTime)
      return
    }

    if (await this.isDeleting(appid)) return

    const ddbDeployManifest = await this.dbService.getDeployManifest(
      region,
      user,
      appid,
    )

    if (!ddbDeployManifest) {
      this.logger.warn(`Deploy manifest not found for ${appid}, skip restart`)
      await this.db
        .collection<DedicatedDatabase>('DedicatedDatabase')
        .updateOne(
          {
            appid,
            state: DedicatedDatabaseState.Restarting,
            phase: DedicatedDatabasePhase.Started,
          },
          {
            $set: {
              state: DedicatedDatabaseState.Stopped,
              phase: DedicatedDatabasePhase.Stopped,
              lockedAt: TASK_LOCK_INIT_TIME,
              updatedAt: new Date(),
            },
          },
        )
      return
    }

    const isRestartSuccessful =
      ddbDeployManifest?.status?.phase === 'Running' &&
      OpsRequestManifest?.status?.phase === 'Succeed'

    if (!isRestartSuccessful) {
      await this.relock(appid, waitingTime)
      return
    }

    if (await this.isDeleting(appid)) return

    await this.dbService.deleteKubeBlockOpsManifest(
      region,
      user,
      appid,
      'restart',
    )

    await db.collection<DedicatedDatabase>('DedicatedDatabase').updateOne(
      {
        appid: appid,
        state: DedicatedDatabaseState.Restarting,
        phase: DedicatedDatabasePhase.Started,
      },
      {
        $set: {
          state: DedicatedDatabaseState.Running,
          phase: DedicatedDatabasePhase.Started,
          lockedAt: TASK_LOCK_INIT_TIME,
          updatedAt: new Date(),
        },
      },
    )
  }

  async handleUpdatingState() {
    const res = await this.db
      .collection<DedicatedDatabase>('DedicatedDatabase')
      .findOneAndUpdate(
        {
          state: DedicatedDatabaseState.Updating,
          phase: DedicatedDatabasePhase.Started,
          lockedAt: { $lt: new Date(Date.now() - this.lockTimeout * 1000) },
        },
        { $set: { lockedAt: new Date() } },
        { sort: { lockedAt: 1, updatedAt: 1 }, returnDocument: 'after' },
      )

    if (!res.value) return
    const data = res.value
    const appid = data.appid
    if (await this.isDeleting(appid)) return

    const region = await this.regionService.findByAppId(appid)
    const user = await this.clusterService.getUserByAppid(appid)
    const manifest = await this.dbService.getDeployManifest(region, user, appid)

    const waitingTime = Date.now() - data.updatedAt.getTime()

    if (!manifest) {
      this.logger.warn(`Deploy manifest not found for ${appid}, skip update`)
      await this.db
        .collection<DedicatedDatabase>('DedicatedDatabase')
        .updateOne(
          {
            appid,
            state: DedicatedDatabaseState.Updating,
            phase: DedicatedDatabasePhase.Started,
          },
          {
            $set: {
              state: DedicatedDatabaseState.Stopped,
              phase: DedicatedDatabasePhase.Stopped,
              lockedAt: TASK_LOCK_INIT_TIME,
              updatedAt: new Date(),
            },
          },
        )
      return
    }

    if (manifest.status?.phase === 'Updating') {
      await this.relock(appid, waitingTime)
      return
    }

    const isDeployManifestChanged =
      await this.dbService.isDeployManifestChanged(region, user, appid)

    if (isDeployManifestChanged) {
      if (await this.isDeleting(appid)) return
      await this.dbService.updateDeployManifest(region, user, appid)
      await this.relock(appid, waitingTime)
      return
    }

    if (manifest.status?.phase !== 'Running') {
      await this.relock(appid, waitingTime)
      return
    }

    const connectionOk = await this.dbService.databaseConnectionIsOk(appid)
    if (!connectionOk) {
      await this.relock(appid, waitingTime)
      return
    }

    if (await this.isDeleting(appid)) return

    await this.dbService.deleteKubeBlockOpsManifestForSpec(
      region,
      user,
      appid,
      'verticalScaling',
    )
    await this.dbService.deleteKubeBlockOpsManifestForSpec(
      region,
      user,
      appid,
      'horizontalScaling',
    )
    await this.dbService.deleteKubeBlockOpsManifestForSpec(
      region,
      user,
      appid,
      'volumeExpansion',
    )

    await this.db.collection<DedicatedDatabase>('DedicatedDatabase').updateOne(
      {
        appid,
        state: DedicatedDatabaseState.Updating,
        phase: DedicatedDatabasePhase.Started,
      },
      {
        $set: {
          state: DedicatedDatabaseState.Running,
          phase: DedicatedDatabasePhase.Started,
          lockedAt: TASK_LOCK_INIT_TIME,
          updatedAt: new Date(),
        },
      },
    )
    return
  }

  /**
   * Relock application by appid, lockedTime is in milliseconds
   */
  async relock(appid: string, lockedTime = 0) {
    if (lockedTime <= 2 * 60 * 1000) {
      lockedTime = Math.ceil(lockedTime / 10)
    }

    if (lockedTime > 2 * 60 * 1000) {
      lockedTime = this.lockTimeout * 1000
    }

    const db = SystemDatabase.db
    const lockedAt = new Date(Date.now() - 1000 * this.lockTimeout + lockedTime)
    await db
      .collection<DedicatedDatabase>('DedicatedDatabase')
      .updateOne(
        { appid: appid, state: { $ne: DedicatedDatabaseState.Deleted } },
        { $set: { lockedAt } },
      )
  }

  private async isDeleting(appid: string) {
    const app = await this.db
      .collection<Application>('Application')
      .findOne({ appid }, { projection: { state: 1, phase: 1 } })

    if (
      !app ||
      app.state === ApplicationState.Deleted ||
      app.phase === ApplicationPhase.Deleting ||
      app.phase === ApplicationPhase.Deleted
    ) {
      return true
    }

    const ddb = await this.db
      .collection<DedicatedDatabase>('DedicatedDatabase')
      .findOne({ appid }, { projection: { state: 1 } })

    return !ddb || ddb.state === DedicatedDatabaseState.Deleted
  }

  private getHourTime() {
    const latestTime = new Date()
    latestTime.setMinutes(0)
    latestTime.setSeconds(0)
    latestTime.setMilliseconds(0)
    latestTime.setHours(latestTime.getHours())
    return latestTime
  }
}
