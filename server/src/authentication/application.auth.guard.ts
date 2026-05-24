import {
  CanActivate,
  ConflictException,
  ExecutionContext,
  Injectable,
  Logger,
} from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { ApplicationService } from '../application/application.service'
import {
  ApplicationPhase,
  ApplicationState,
} from 'src/application/entities/application'
import { ALLOW_DELETING_APPLICATION_KEY } from './allow-deleting-application.decorator'
import { IRequest } from '../utils/interface'
import { User } from 'src/user/entities/user'

@Injectable()
export class ApplicationAuthGuard implements CanActivate {
  logger = new Logger(ApplicationAuthGuard.name)
  constructor(
    private readonly appService: ApplicationService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest() as IRequest
    const appid = request.params.appid
    const user = request.user as User

    // check appid
    const rawApp = await this.appService.findOneRaw(appid)
    if (!rawApp) {
      return false
    }

    if (!rawApp.createdBy.equals(user._id)) {
      return false
    }

    const isDeleting = this.isDeleting(rawApp)
    const allowDeletingApplication = this.reflector.getAllAndOverride<boolean>(
      ALLOW_DELETING_APPLICATION_KEY,
      [context.getHandler(), context.getClass()],
    )

    if (this.isMutatingRequest(request) && isDeleting) {
      if (!allowDeletingApplication) {
        throw new ConflictException('application is deleting')
      }
    }

    // inject app to request
    if (isDeleting && allowDeletingApplication) {
      request.application = rawApp
      return true
    }

    const app = await this.appService.findOne(appid)
    if (!app) {
      return false
    }

    request.application = app

    return true
  }

  private isMutatingRequest(request: IRequest) {
    return !['GET', 'HEAD', 'OPTIONS'].includes(request.method)
  }

  private isDeleting(app: {
    state?: ApplicationState
    phase?: ApplicationPhase
  }) {
    return (
      app.state === ApplicationState.Deleted ||
      app.phase === ApplicationPhase.Deleting ||
      app.phase === ApplicationPhase.Deleted
    )
  }
}
