import { ClusterService } from 'src/region/cluster/cluster.service'
import { Injectable, Logger } from '@nestjs/common'
import { RegionService } from '../region/region.service'
import * as assert from 'node:assert'
import { Cron, CronExpression } from '@nestjs/schedule'
import { ServerConfig, TASK_LOCK_INIT_TIME } from '../constants'
import { SystemDatabase } from '../system-database'
import {
  DomainPhase,
  DomainState,
  RuntimeDomain,
} from './entities/runtime-domain'
import {
  Application,
  ApplicationPhase,
  ApplicationState,
} from 'src/application/entities/application'
import { CertificateService } from './certificate.service'
import { isConditionTrue } from 'src/utils/getter'
import { RuntimeGatewayService } from './ingress/runtime-ingress.service'

@Injectable()
export class RuntimeDomainTaskService {
  readonly lockTimeout = 30 // in second
  private readonly logger = new Logger(RuntimeDomainTaskService.name)

  constructor(
    private readonly runtimeGateway: RuntimeGatewayService,
    private readonly regionService: RegionService,
    private readonly certService: CertificateService,
    private readonly clusterService: ClusterService,
  ) {}

  @Cron(CronExpression.EVERY_SECOND)
  async tick() {
    if (ServerConfig.DISABLED_GATEWAY_TASK) return

    // Phase `Creating` -> `Created`
    this.handleCreatingPhase().catch((err) => {
      this.logger.error(err)
      err.response && this.logger.error(JSON.stringify(err.response))
    })

    // Phase `Deleting` -> `Deleted`
    this.handleDeletingPhase().catch((err) => {
      this.logger.error(err)
      err.response && this.logger.error(JSON.stringify(err.response))
    })

    // Phase `Created` -> `Deleting`
    this.handleInactiveState().catch((err) => {
      this.logger.error(err)
      err.response && this.logger.error(JSON.stringify(err.response))
    })

    // Phase `Deleted` -> `Creating`
    this.handleActiveState().catch((err) => {
      this.logger.error(err)
      err.response && this.logger.error(JSON.stringify(err.response))
    })

    // Phase `Deleting` -> `Deleted`
    this.handleDeletedState().catch((err) => {
      this.logger.error(err)
      err.response && this.logger.error(JSON.stringify(err.response))
    })
  }

  /**
   * Phase `Creating` -> `Created`:
   * - create route
   * - move phase `Creating` to `Created`
   */
  async handleCreatingPhase() {
    if (ServerConfig.DISABLED_GATEWAY_TASK) return

    const db = SystemDatabase.db

    const res = await db
      .collection<RuntimeDomain>('RuntimeDomain')
      .findOneAndUpdate(
        {
          state: DomainState.Active,
          phase: DomainPhase.Creating,
          lockedAt: { $lt: new Date(Date.now() - 1000 * this.lockTimeout) },
        },
        { $set: { lockedAt: new Date() } },
        { returnDocument: 'after' },
      )

    if (!res.value) return

    // get region by appid
    const doc = res.value
    this.logger.log('handleCreatingPhase matched function domain ' + doc.appid)

    if (await this.isApplicationDeleting(doc.appid)) {
      await this.markDeleting(doc)
      return
    }

    const region = await this.regionService.findByAppId(doc.appid)
    assert(region, 'region not found')

    const user = await this.clusterService.getUserByAppid(doc.appid)

    // issue ssl certificate
    // Warning: create certificate before ingress, otherwise apisix ingress will not work
    if (doc.customDomain && region.gatewayConf.tls) {
      if (await this.isApplicationDeleting(doc.appid)) {
        await this.markDeleting(doc)
        return
      }

      // create custom certificate if custom domain is set
      const waitingTime = Date.now() - doc.updatedAt.getTime()

      // create custom domain certificate
      let cert = await this.certService.getRuntimeCertificate(user, doc)
      if (!cert) {
        if (await this.isApplicationDeleting(doc.appid)) {
          await this.markDeleting(doc)
          return
        }

        cert = await this.certService.createRuntimeCertificate(user, doc)
        this.logger.log(`create runtime domain certificate: ${doc.appid}`)

        if (await this.isApplicationDeleting(doc.appid)) {
          await this.markDeleting(doc)
          return
        }

        // return to wait for cert to be ready
        return await this.relock(doc.appid, waitingTime)
      }

      // check if cert status is Ready
      const conditions = (cert as any).status?.conditions || []
      if (!isConditionTrue('Ready', conditions)) {
        this.logger.log(`runtime domain certificate is not ready: ${doc.appid}`)
        // return to wait for cert to be ready
        return await this.relock(doc.appid, waitingTime)
      }
    }

    // create ingress if not exists
    if (await this.isApplicationDeleting(doc.appid)) {
      await this.markDeleting(doc)
      return
    }

    const ingress = await this.runtimeGateway.getIngress(doc)
    if (!ingress) {
      if (await this.isApplicationDeleting(doc.appid)) {
        await this.markDeleting(doc)
        return
      }

      const res = await this.runtimeGateway.createIngress(region, doc)
      this.logger.log('runtime default ingress created: ' + doc.appid)
      this.logger.debug(JSON.stringify(res))

      if (await this.isApplicationDeleting(doc.appid)) {
        await this.markDeleting(doc)
        return
      }
    }

    // update phase to `Created`
    await db.collection<RuntimeDomain>('RuntimeDomain').updateOne(
      { _id: doc._id, state: DomainState.Active, phase: DomainPhase.Creating },
      {
        $set: {
          phase: DomainPhase.Created,
          lockedAt: TASK_LOCK_INIT_TIME,
          updatedAt: new Date(),
        },
      },
    )

    this.logger.log('app domain phase updated to Created ' + doc.domain)
  }

  /**
   * Phase `Deleting` -> `Deleted`:
   * - delete route
   * - move phase `Deleting` to `Deleted`
   */
  async handleDeletingPhase() {
    const db = SystemDatabase.db

    const res = await db
      .collection<RuntimeDomain>('RuntimeDomain')
      .findOneAndUpdate(
        {
          phase: DomainPhase.Deleting,
          lockedAt: { $lt: new Date(Date.now() - 1000 * this.lockTimeout) },
        },
        { $set: { lockedAt: new Date() } },
        { returnDocument: 'after' },
      )
    if (!res.value) return

    // get region by appid
    const doc = res.value
    const region = await this.regionService.findByAppId(doc.appid)
    assert(region, 'region not found')

    const user = await this.clusterService.getUserByAppid(doc.appid)

    // delete ingress if exists
    const ingress = await this.runtimeGateway.getIngress(doc)
    if (ingress) {
      const res = await this.runtimeGateway.deleteIngress(doc)
      this.logger.log('runtime ingress deleted: ' + doc.appid)
      this.logger.debug(JSON.stringify(res))
    }

    /* Certificates are only removed when you delete the application and unbind the custom runtime domain.
    Starting, restarting and stopping the application does not remove certificates */

    if (
      doc.state === DomainState.Deleted ||
      (doc.state === DomainState.Active && doc.phase === DomainPhase.Deleting)
    ) {
      // delete app custom certificate if custom domain is set
      const waitingTime = Date.now() - doc.updatedAt.getTime()

      const cert = await this.certService.getRuntimeCertificate(user, doc)
      if (cert) {
        await this.certService.deleteRuntimeCertificate(user, doc)
        this.logger.log(`delete runtime custom domain cert: ${doc.appid}`)
        // return to wait for cert to be deleted
        return await this.relock(doc.appid, waitingTime)
      }
    }

    // update phase to `Deleted`
    await db.collection<RuntimeDomain>('RuntimeDomain').updateOne(
      { _id: doc._id, phase: DomainPhase.Deleting },
      {
        $set: {
          phase: DomainPhase.Deleted,
          lockedAt: TASK_LOCK_INIT_TIME,
          updatedAt: new Date(),
        },
      },
    )

    this.logger.log('app domain phase updated to Deleted: ' + doc.appid)
  }

  /**
   * State `Active`:
   * - move phase `Deleted` ->  `Creating`
   */
  async handleActiveState() {
    const db = SystemDatabase.db

    await db.collection<RuntimeDomain>('RuntimeDomain').updateMany(
      {
        state: DomainState.Active,
        phase: DomainPhase.Deleted,
        lockedAt: { $lt: new Date(Date.now() - 1000 * this.lockTimeout) },
      },
      {
        $set: {
          phase: DomainPhase.Creating,
          lockedAt: TASK_LOCK_INIT_TIME,
          updatedAt: new Date(),
        },
      },
    )
  }

  /**
   * State `Inactive`:
   * - move `Created` ->  `Deleting`
   */
  async handleInactiveState() {
    const db = SystemDatabase.db

    await db.collection<RuntimeDomain>('RuntimeDomain').updateMany(
      {
        state: DomainState.Inactive,
        phase: { $in: [DomainPhase.Created, DomainPhase.Creating] },
        lockedAt: { $lt: new Date(Date.now() - 1000 * this.lockTimeout) },
      },
      {
        $set: {
          phase: DomainPhase.Deleting,
          lockedAt: TASK_LOCK_INIT_TIME,
          updatedAt: new Date(),
        },
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

    await db.collection<RuntimeDomain>('RuntimeDomain').updateMany(
      {
        state: DomainState.Deleted,
        phase: { $in: [DomainPhase.Created, DomainPhase.Creating] },
        lockedAt: { $lt: new Date(Date.now() - 1000 * this.lockTimeout) },
      },
      {
        $set: {
          phase: DomainPhase.Deleting,
          lockedAt: TASK_LOCK_INIT_TIME,
          updatedAt: new Date(),
        },
      },
    )

    await db.collection<RuntimeDomain>('RuntimeDomain').deleteMany({
      state: DomainState.Deleted,
      phase: DomainPhase.Deleted,
    })
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
      .collection<RuntimeDomain>('RuntimeDomain')
      .updateOne({ appid }, { $set: { lockedAt } })
  }

  private async markDeleting(doc: RuntimeDomain) {
    const db = SystemDatabase.db
    await db.collection<RuntimeDomain>('RuntimeDomain').updateOne(
      { _id: doc._id, phase: DomainPhase.Creating },
      {
        $set: {
          state: DomainState.Deleted,
          phase: DomainPhase.Deleting,
          lockedAt: TASK_LOCK_INIT_TIME,
          updatedAt: new Date(),
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
