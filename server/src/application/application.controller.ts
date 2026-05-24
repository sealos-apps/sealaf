import {
  Controller,
  Get,
  Body,
  Patch,
  Param,
  UseGuards,
  Logger,
  Post,
  Delete,
  ForbiddenException,
} from '@nestjs/common'
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger'
import { JwtAuthGuard } from '../authentication/jwt.auth.guard'
import {
  ApiResponseArray,
  ApiResponseObject,
  ResponseUtil,
} from '../utils/response'
import { ApplicationAuthGuard } from '../authentication/application.auth.guard'
import {
  UpdateApplicationBundleDto,
  UpdateApplicationNameDto,
  UpdateApplicationStateDto,
} from './dto/update-application.dto'
import { ApplicationService } from './application.service'
import { FunctionService } from '../function/function.service'
import { RegionService } from 'src/region/region.service'
import { CreateApplicationDto } from './dto/create-application.dto'
import {
  Application,
  ApplicationPhase,
  ApplicationState,
  ApplicationWithRelations,
} from './entities/application'
import { SystemDatabase } from 'src/system-database'
import { Runtime } from './entities/runtime'
import { ObjectId } from 'mongodb'
import { ApplicationBundle } from './entities/application-bundle'
import { ResourceService } from 'src/billing/resource.service'
import { RuntimeDomainService } from 'src/gateway/runtime-domain.service'
import { RuntimeDomain } from 'src/gateway/entities/runtime-domain'
import { InjectApplication, InjectUser } from 'src/utils/decorator'
import { User } from 'src/user/entities/user'
import { isEqual } from 'lodash'
import { InstanceService } from 'src/instance/instance.service'
import { BindCustomDomainDto } from './dto/bind-custom-domain.dto'
import { ClusterService } from 'src/region/cluster/cluster.service'
import { SealosManagerGuard } from 'src/authentication/sealos-manager.guard'
import { AllowDeletingApplication } from 'src/authentication/allow-deleting-application.decorator'
import { DedicatedDatabaseService } from 'src/database/dedicated-database/dedicated-database.service'
import {
  DedicatedDatabasePhase,
  DedicatedDatabaseState,
} from 'src/database/entities/dedicated-database'

@ApiTags('Application')
@Controller('applications')
@ApiBearerAuth('Authorization')
export class ApplicationController {
  private logger = new Logger(ApplicationController.name)

  constructor(
    private readonly application: ApplicationService,
    private readonly dedicateDatabase: DedicatedDatabaseService,
    private readonly instance: InstanceService,
    private readonly fn: FunctionService,
    private readonly region: RegionService,
    private readonly resource: ResourceService,
    private readonly runtimeDomain: RuntimeDomainService,
    private readonly clusterService: ClusterService,
  ) {}

  /**
   * Create application
   */
  @UseGuards(JwtAuthGuard, SealosManagerGuard)
  @ApiOperation({ summary: 'Create application' })
  @ApiResponseObject(ApplicationWithRelations)
  @Post()
  async create(@Body() dto: CreateApplicationDto, @InjectUser() user: User) {
    const error = dto.validate() || dto.autoscaling.validate()
    if (error) {
      return ResponseUtil.error(error)
    }

    // check regionId exists
    const region = await this.region.findOne(new ObjectId(dto.regionId))
    if (!region) {
      return ResponseUtil.error(`region ${dto.regionId} not found`)
    }

    // check runtimeId exists
    const runtime = await SystemDatabase.db
      .collection<Runtime>('Runtime')
      .findOne({ _id: new ObjectId(dto.runtimeId) })
    if (!runtime) {
      return ResponseUtil.error(`runtime ${dto.runtimeId} not found`)
    }

    const regionId = region._id

    // check if trial tier
    const isTrialTier = await this.resource.isTrialBundle(dto)
    if (isTrialTier) {
      const bundle = await this.resource.findTrialBundle(regionId)
      const trials = await this.application.findTrialApplications(user._id)
      const limitOfFreeTier = bundle?.limitCountOfFreeTierPerUser || 0
      if (trials.length >= (limitOfFreeTier || 0)) {
        return ResponseUtil.error(
          `you can only create ${limitOfFreeTier} trial applications`,
        )
      }
    }

    const checkSpec = await this.checkResourceSpecification(dto, regionId)
    if (!checkSpec) {
      return ResponseUtil.error('invalid resource specification')
    }

    // create application
    const appid = await this.application.tryGenerateUniqueAppid()
    await this.application.create(regionId, user._id, appid, dto, isTrialTier)

    const app = await this.application.findOne(appid)
    return ResponseUtil.ok(app)
  }

  /**
   * Get user application list
   * @param req
   * @returns
   */
  @UseGuards(JwtAuthGuard)
  @Get()
  @ApiOperation({ summary: 'Get user application list' })
  @ApiResponseArray(ApplicationWithRelations)
  async findAll(@InjectUser() user: User) {
    const data = await this.application.findAllByUser(user._id)
    return ResponseUtil.ok(data)
  }

  /**
   * Get an application by appid
   * @param appid
   * @returns
   */
  @ApiOperation({ summary: 'Get an application by appid' })
  @UseGuards(JwtAuthGuard, ApplicationAuthGuard)
  @Get(':appid')
  async findOne(@Param('appid') appid: string, @InjectUser() user: User) {
    const data = await this.application.findOne(appid)

    // SECURITY ALERT!!!
    // DO NOT response this region object to client since it contains sensitive information
    const region = await this.region.findOne(data.regionId)

    let storage = {}
    const storageUser = await this.clusterService.getStorageConf(user)
    if (storageUser) {
      storage = {
        endpoint: storageUser.external,
        accessKey: storageUser.accessKey,
        secretKey: storageUser.secretKey,
      }
    }

    // Generate the develop token, it's provided to the client when debugging function
    const expires = 60 * 60 * 24 * 7
    const develop_token = await this.fn.generateRuntimeToken(
      appid,
      'develop',
      expires,
    )
    const openapi_token = await this.fn.generateRuntimeToken(
      appid,
      'openapi',
      expires,
    )

    const res = {
      ...data,
      storage,
      port: region.gatewayConf.port,
      develop_token: develop_token,
      openapi_token: openapi_token,

      /** This is the redundant field of Region */
      tls: region.gatewayConf.tls.enabled,
    }

    return ResponseUtil.ok(res)
  }

  /**
   * Update application name
   */
  @ApiOperation({ summary: 'Update application name' })
  @ApiResponseObject(Application)
  @UseGuards(JwtAuthGuard, SealosManagerGuard, ApplicationAuthGuard)
  @Patch(':appid/name')
  async updateName(
    @Param('appid') appid: string,
    @Body() dto: UpdateApplicationNameDto,
  ) {
    const doc = await this.application.updateName(appid, dto.name)
    return ResponseUtil.ok(doc)
  }

  /**
   * Update application state
   */
  @ApiOperation({ summary: 'Update application state' })
  @ApiResponseObject(Application)
  @UseGuards(JwtAuthGuard, SealosManagerGuard, ApplicationAuthGuard)
  @Patch(':appid/state')
  async updateState(
    @Param('appid') appid: string,
    @Body() dto: UpdateApplicationStateDto,
    @InjectApplication() app: Application,
  ) {
    if (dto.state === ApplicationState.Deleted) {
      throw new ForbiddenException('cannot update state to deleted')
    }
    // check: only running application can restart
    if (
      dto.state === ApplicationState.Restarting &&
      !(
        app.state === ApplicationState.Running &&
        app.phase === ApplicationPhase.Started
      )
    ) {
      return ResponseUtil.error(
        'The application is not running, can not restart it',
      )
    }

    // check: only running application can stop
    if (
      dto.state === ApplicationState.Stopped &&
      (app.state !== ApplicationState.Running ||
        app.phase !== ApplicationPhase.Started)
    ) {
      return ResponseUtil.error(
        'The application is not running, can not stop it',
      )
    }

    // check: only stopped application can start
    if (
      dto.state === ApplicationState.Running &&
      (app.state !== ApplicationState.Stopped ||
        app.phase !== ApplicationPhase.Stopped)
    ) {
      return ResponseUtil.error(
        'The application is not stopped, can not start it',
      )
    }

    if (dto.state === ApplicationState.Restarting && dto?.onlyRuntimeFlag) {
      const doc = await this.application.updateState(appid, dto.state)
      return ResponseUtil.ok(doc)
    }

    const doc = await this.application.updateState(appid, dto.state)
    await this.dedicateDatabase.updateState(
      appid,
      dto.state as unknown as DedicatedDatabaseState,
    )
    return ResponseUtil.ok(doc)
  }

  /**
   * Update application bundle
   */
  @ApiOperation({ summary: 'Update application bundle' })
  @ApiResponseObject(ApplicationBundle)
  @UseGuards(JwtAuthGuard, SealosManagerGuard, ApplicationAuthGuard)
  @Patch(':appid/bundle')
  async updateBundle(
    @Param('appid') appid: string,
    @Body() dto: UpdateApplicationBundleDto,
    @InjectApplication() app: ApplicationWithRelations,
  ) {
    // only running application can update bundle
    if (app.phase !== ApplicationPhase.Started) {
      return ResponseUtil.error(
        'The application is not running, can not update bundle',
      )
    }

    const error = dto.autoscaling.validate()
    if (error) {
      return ResponseUtil.error(error)
    }

    const userid = app.createdBy
    const regionId = app.regionId

    // check if trial tier
    const isTrialTier = await this.resource.isTrialBundle({
      ...dto,
      regionId: regionId.toString(),
    })
    if (isTrialTier) {
      const bundle = await this.resource.findTrialBundle(regionId)
      const trials = await this.application.findTrialApplications(userid)
      const limitOfFreeTier = bundle?.limitCountOfFreeTierPerUser || 0
      if (trials.length >= (limitOfFreeTier || 0)) {
        return ResponseUtil.error(
          `you can only create ${limitOfFreeTier} trial applications`,
        )
      }
    }

    const origin = app.bundle

    const checkSpec = await this.checkResourceSpecification(dto, regionId, app)
    if (!checkSpec) {
      return ResponseUtil.error('invalid resource specification')
    }

    // Check if user is trying to change database resources
    const isTryingToChangeDatabase =
      (dto.dedicatedDatabase?.cpu !== undefined &&
        dto.dedicatedDatabase?.cpu !==
          origin.resource.dedicatedDatabase?.limitCPU) ||
      (dto.dedicatedDatabase?.memory !== undefined &&
        dto.dedicatedDatabase?.memory !==
          origin.resource.dedicatedDatabase?.limitMemory) ||
      (dto.dedicatedDatabase?.replicas !== undefined &&
        dto.dedicatedDatabase?.replicas !==
          origin.resource.dedicatedDatabase?.replicas) ||
      (dto.dedicatedDatabase?.capacity !== undefined &&
        dto.dedicatedDatabase?.capacity !==
          origin.resource.dedicatedDatabase?.capacity)

    if (isTryingToChangeDatabase) {
      // Database must be running to change database resources
      const dedicatedDatabase = await this.dedicateDatabase.findOne(appid)
      if (!dedicatedDatabase) {
        return ResponseUtil.error(
          'Database not found, cannot change database resources',
        )
      }
      if (
        dedicatedDatabase.state !== DedicatedDatabaseState.Running ||
        dedicatedDatabase.phase !== DedicatedDatabasePhase.Started
      ) {
        return ResponseUtil.error(
          'Database is not in running state, cannot change database resources',
        )
      }
    }

    if (
      dto.dedicatedDatabase?.capacity &&
      origin.resource.dedicatedDatabase?.capacity &&
      dto.dedicatedDatabase?.capacity <
        origin.resource.dedicatedDatabase?.capacity
    ) {
      return ResponseUtil.error('cannot reduce database capacity')
    }

    if (
      dto.dedicatedDatabase?.replicas &&
      origin.resource.dedicatedDatabase?.replicas &&
      dto.dedicatedDatabase?.replicas <
        origin.resource.dedicatedDatabase?.replicas
    ) {
      return ResponseUtil.error(
        'To reduce the number of database replicas, please contact customer support.',
      )
    }

    const doc = await this.application.updateBundle(appid, dto, isTrialTier)

    // restart running application if cpu or memory changed
    const isCpuChanged = origin.resource.limitCPU !== doc.resource.limitCPU
    const isMemoryChanged =
      origin.resource.limitMemory !== doc.resource.limitMemory

    const isAutoscalingCanceled =
      !doc.autoscaling.enable && origin.autoscaling.enable

    const isRuntimeChanged =
      isCpuChanged || isMemoryChanged || isAutoscalingCanceled

    const isDedicatedDatabaseChanged =
      !!origin.resource.dedicatedDatabase &&
      (!isEqual(
        origin.resource.dedicatedDatabase.limitCPU,
        doc.resource.dedicatedDatabase.limitCPU,
      ) ||
        !isEqual(
          origin.resource.dedicatedDatabase.limitMemory,
          doc.resource.dedicatedDatabase.limitMemory,
        ) ||
        !isEqual(
          origin.resource.dedicatedDatabase.replicas,
          doc.resource.dedicatedDatabase.replicas,
        ) ||
        !isEqual(
          origin.resource.dedicatedDatabase.capacity,
          doc.resource.dedicatedDatabase.capacity,
        ))

    if (!isEqual(doc.autoscaling, origin.autoscaling)) {
      const { hpa, app } = await this.instance.get(appid)
      await this.instance.reapplyHorizontalPodAutoscaler(app, hpa)
    }

    if (isDedicatedDatabaseChanged) {
      await this.application.updateState(appid, ApplicationState.Restarting)
      await this.dedicateDatabase.updateState(
        appid,
        DedicatedDatabaseState.Restarting,
      )
      return ResponseUtil.ok(doc)
    }

    if (isRuntimeChanged) {
      await this.application.updateState(appid, ApplicationState.Restarting)
    }

    return ResponseUtil.ok(doc)
  }

  /**
   * Bind custom domain to application
   */
  @ApiResponseObject(RuntimeDomain)
  @ApiOperation({ summary: 'Bind custom domain to application' })
  @UseGuards(JwtAuthGuard, ApplicationAuthGuard)
  @Patch(':appid/domain')
  async bindDomain(
    @Param('appid') appid: string,
    @Body() dto: BindCustomDomainDto,
  ) {
    const runtimeDomain = await this.runtimeDomain.findOne(appid)
    if (
      runtimeDomain?.customDomain &&
      runtimeDomain.customDomain === dto.domain
    ) {
      return ResponseUtil.error('domain already binded')
    }

    // check if domain resolved
    const resolved = await this.runtimeDomain.checkResolved(appid, dto.domain)
    if (!resolved) {
      return ResponseUtil.error('domain not resolved')
    }

    // bind domain
    const binded = await this.runtimeDomain.bindCustomDomain(appid, dto.domain)
    if (!binded) {
      return ResponseUtil.error('failed to bind domain')
    }

    return ResponseUtil.ok(binded)
  }

  /**
   * Check if domain is resolved
   */
  @ApiResponse({ type: ResponseUtil<boolean> })
  @ApiOperation({ summary: 'Check if domain is resolved' })
  @UseGuards(JwtAuthGuard, ApplicationAuthGuard)
  @Post(':appid/domain/resolved')
  async checkResolved(
    @Param('appid') appid: string,
    @Body() dto: BindCustomDomainDto,
  ) {
    const resolved = await this.runtimeDomain.checkResolved(appid, dto.domain)
    if (!resolved) {
      return ResponseUtil.error('domain not resolved')
    }

    return ResponseUtil.ok(resolved)
  }

  /**
   * Remove custom domain of application
   */
  @ApiResponseObject(RuntimeDomain)
  @ApiOperation({ summary: 'Remove custom domain of application' })
  @UseGuards(JwtAuthGuard, SealosManagerGuard, ApplicationAuthGuard)
  @Delete(':appid/domain')
  async remove(@Param('appid') appid: string) {
    const runtimeDomain = await this.runtimeDomain.findOne(appid)
    if (!runtimeDomain?.customDomain) {
      return ResponseUtil.error('custom domain not found')
    }

    const deleted = await this.runtimeDomain.removeCustomDomain(appid)
    if (!deleted) {
      return ResponseUtil.error('failed to remove custom domain')
    }

    return ResponseUtil.ok(deleted)
  }

  /**
   * Delete an application
   */
  @ApiOperation({ summary: 'Delete an application' })
  @ApiResponseObject(Application)
  @UseGuards(JwtAuthGuard, SealosManagerGuard, ApplicationAuthGuard)
  @AllowDeletingApplication()
  @Delete(':appid')
  async delete(@Param('appid') appid: string) {
    const doc = await this.application.remove(appid)
    return ResponseUtil.ok(doc)
  }

  private async checkResourceSpecification(
    dto: UpdateApplicationBundleDto,
    regionId: ObjectId,
    app?: ApplicationWithRelations,
  ) {
    const resourceOptions = await this.resource.findAllByRegionId(regionId)

    if (app) {
      const checkSpec = resourceOptions.every((option) => {
        switch (option.type) {
          case 'cpu':
            return (
              option.specs.some((spec) => spec.value === dto.cpu) ||
              app.bundle.resource.limitCPU === dto.cpu
            )
          case 'memory':
            return (
              option.specs.some((spec) => spec.value === dto.memory) ||
              app.bundle.resource.limitMemory === dto.memory
            )
          // dedicated database
          case 'dedicatedDatabaseCPU':
            return (
              !dto.dedicatedDatabase?.cpu ||
              option.specs.some(
                (spec) => spec.value === dto.dedicatedDatabase.cpu,
              ) ||
              app.bundle.resource.dedicatedDatabase?.limitCPU ===
                dto.dedicatedDatabase.cpu
            )
          case 'dedicatedDatabaseMemory':
            return (
              !dto.dedicatedDatabase?.memory ||
              option.specs.some(
                (spec) => spec.value === dto.dedicatedDatabase.memory,
              ) ||
              app.bundle.resource.dedicatedDatabase?.limitMemory ===
                dto.dedicatedDatabase.memory
            )
          case 'dedicatedDatabaseCapacity':
            return (
              !dto.dedicatedDatabase?.capacity ||
              option.specs.some(
                (spec) => spec.value === dto.dedicatedDatabase.capacity,
              ) ||
              app.bundle.resource.dedicatedDatabase?.capacity ===
                dto.dedicatedDatabase.capacity
            )
          case 'dedicatedDatabaseReplicas':
            return (
              !dto.dedicatedDatabase?.replicas ||
              option.specs.some(
                (spec) => spec.value === dto.dedicatedDatabase.replicas,
              ) ||
              app.bundle.resource.dedicatedDatabase?.replicas ===
                dto.dedicatedDatabase.replicas
            )
          default:
            return true
        }
      })
      return checkSpec
    }

    const checkSpec = resourceOptions.every((option) => {
      switch (option.type) {
        case 'cpu':
          return option.specs.some((spec) => spec.value === dto.cpu)
        case 'memory':
          return option.specs.some((spec) => spec.value === dto.memory)
        // dedicated database
        case 'dedicatedDatabaseCPU':
          return (
            !dto.dedicatedDatabase?.cpu ||
            option.specs.some(
              (spec) => spec.value === dto.dedicatedDatabase.cpu,
            )
          )
        case 'dedicatedDatabaseMemory':
          return (
            !dto.dedicatedDatabase?.memory ||
            option.specs.some(
              (spec) => spec.value === dto.dedicatedDatabase.memory,
            )
          )
        case 'dedicatedDatabaseCapacity':
          return (
            !dto.dedicatedDatabase?.capacity ||
            option.specs.some(
              (spec) => spec.value === dto.dedicatedDatabase.capacity,
            )
          )
        case 'dedicatedDatabaseReplicas':
          return (
            !dto.dedicatedDatabase?.replicas ||
            option.specs.some(
              (spec) => spec.value === dto.dedicatedDatabase.replicas,
            )
          )
        default:
          return true
      }
    })

    return checkSpec
  }
}
