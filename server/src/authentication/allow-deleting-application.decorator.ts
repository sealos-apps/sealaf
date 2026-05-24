import { SetMetadata } from '@nestjs/common'

export const ALLOW_DELETING_APPLICATION_KEY = 'allowDeletingApplication'

export const AllowDeletingApplication = () =>
  SetMetadata(ALLOW_DELETING_APPLICATION_KEY, true)
