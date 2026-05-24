import { Injectable, Logger } from '@nestjs/common'
import { Cron, CronExpression } from '@nestjs/schedule'
import { ServerConfig, TASK_LOCK_INIT_TIME } from 'src/constants'
import { SystemDatabase } from 'src/system-database'
import { CronJobService } from './cron-job.service'
import {
  CronTrigger,
  TriggerPhase,
  TriggerState,
} from './entities/cron-trigger'
import {
  Application,
  ApplicationPhase,
  ApplicationState,
} from 'src/application/entities/application'

@Injectable()
export class TriggerTaskService {
  readonly lockTimeout = 30 // in second
  readonly concurrency = 1 // concurrency count
  private readonly logger = new Logger(TriggerTaskService.name)

  constructor(private readonly cronService: CronJobService) {}

  @Cron(CronExpression.EVERY_SECOND)
  async tick() {
    if (ServerConfig.DISABLED_TRIGGER_TASK) return

    // Phase `Creating` -> `Created`
    this.handleCreatingPhase().catch((err) => {
      this.logger.error('handleCreatingPhase error: ' + err)
    })

    // Phase `Deleting` -> `Deleted`
    this.handleDeletingPhase().catch((err) => {
      this.logger.error('handleDeletingPhase error: ' + err)
    })

    // Phase `Created` -> `Deleting`
    this.handleInactiveState().catch((err) => {
      this.logger.error('handleInactiveState error: ' + err)
    })

    // Phase `Deleted` -> `Creating`
    this.handleActiveState().catch((err) => {
      this.logger.error('handleActiveState error: ' + err)
    })

    // Phase `Deleting` -> `Deleted`
    this.handleDeletedState().catch((err) => {
      this.logger.error('handleDeletedState error: ' + err)
    })
  }

  /**
   * Phase `Creating`:
   * - create cron job of trigger
   * - move phase `Creating` to `Created`
   */
  async handleCreatingPhase() {
    const db = SystemDatabase.db

    const res = await db
      .collection<CronTrigger>('CronTrigger')
      .findOneAndUpdate(
        {
          state: TriggerState.Active,
          phase: TriggerPhase.Creating,
          lockedAt: { $lt: new Date(Date.now() - 1000 * this.lockTimeout) },
        },
        { $set: { lockedAt: new Date() } },
        { returnDocument: 'after' },
      )
    if (!res.value) return

    const doc = res.value

    if (await this.isApplicationDeleting(doc.appid)) {
      await this.markDeleting(doc)
      return
    }

    // create cron job if not exists
    const job = await this.cronService.findOne(doc)
    if (!job) {
      if (await this.isApplicationDeleting(doc.appid)) {
        await this.markDeleting(doc)
        return
      }

      await this.cronService.create(doc)
      this.logger.log('cron job created: ' + doc._id)

      if (await this.isApplicationDeleting(doc.appid)) {
        await this.markDeleting(doc)
        return
      }
    }

    // update phase to `Created`
    await db.collection<CronTrigger>('CronTrigger').updateOne(
      {
        _id: doc._id,
        state: TriggerState.Active,
        phase: TriggerPhase.Creating,
      },
      {
        $set: { phase: TriggerPhase.Created, lockedAt: TASK_LOCK_INIT_TIME },
      },
    )

    this.logger.log('trigger phase updated to Created: ' + doc._id)
  }

  /**
   * Phase `Deleting`:
   * - delete cron job of trigger
   * - move phase `Deleting` to `Deleted`
   */
  async handleDeletingPhase() {
    const db = SystemDatabase.db

    const res = await db
      .collection<CronTrigger>('CronTrigger')
      .findOneAndUpdate(
        {
          phase: TriggerPhase.Deleting,
          lockedAt: { $lt: new Date(Date.now() - 1000 * this.lockTimeout) },
        },
        { $set: { lockedAt: new Date() } },
        { returnDocument: 'after' },
      )
    if (!res.value) return

    const doc = res.value

    // delete cron job if exists
    const job = await this.cronService.findOne(doc)
    if (job) {
      await this.cronService.delete(doc)
      this.logger.log('cron job deleted: ' + doc._id)
    }

    // update phase to `Deleted`
    await db.collection<CronTrigger>('CronTrigger').updateOne(
      { _id: doc._id, phase: TriggerPhase.Deleting },
      {
        $set: { phase: TriggerPhase.Deleted, lockedAt: TASK_LOCK_INIT_TIME },
      },
    )

    this.logger.debug('cron trigger phase updated to Deleted: ' + doc._id)
  }

  /**
   * State `Active`:
   * - move phase `Deleted` to `Creating`
   */
  async handleActiveState() {
    const db = SystemDatabase.db

    await db.collection<CronTrigger>('CronTrigger').updateMany(
      { state: TriggerState.Active, phase: TriggerPhase.Deleted },
      {
        $set: { phase: TriggerPhase.Creating, lockedAt: TASK_LOCK_INIT_TIME },
      },
    )
  }

  /**
   * State `Inactive`:
   * - move `Created` to `Deleting`
   */
  async handleInactiveState() {
    const db = SystemDatabase.db

    await db.collection<CronTrigger>('CronTrigger').updateMany(
      {
        state: TriggerState.Inactive,
        phase: { $in: [TriggerPhase.Created, TriggerPhase.Creating] },
      },
      {
        $set: { phase: TriggerPhase.Deleting, lockedAt: TASK_LOCK_INIT_TIME },
      },
    )
  }

  /**
   * State `Deleted`:
   * - move `Created` to `Deleting`
   * - delete `Deleted` documents
   */
  async handleDeletedState() {
    const db = SystemDatabase.db

    await db.collection<CronTrigger>('CronTrigger').updateMany(
      {
        state: TriggerState.Deleted,
        phase: { $in: [TriggerPhase.Creating, TriggerPhase.Created] },
      },
      {
        $set: { phase: TriggerPhase.Deleting, lockedAt: TASK_LOCK_INIT_TIME },
      },
    )

    await db
      .collection<CronTrigger>('CronTrigger')
      .deleteMany({ state: TriggerState.Deleted, phase: TriggerPhase.Deleted })
  }

  private async markDeleting(doc: CronTrigger) {
    const db = SystemDatabase.db
    await db.collection<CronTrigger>('CronTrigger').updateOne(
      { _id: doc._id, phase: TriggerPhase.Creating },
      {
        $set: {
          state: TriggerState.Deleted,
          phase: TriggerPhase.Deleting,
          lockedAt: TASK_LOCK_INIT_TIME,
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
