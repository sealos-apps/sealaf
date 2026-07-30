import { NextFunction, Request, Response } from 'express'

export const healthzPayload = {
  service: 'sealaf',
  status: 'ok',
} as const

export function healthzMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  if (req.method !== 'GET' || req.path !== '/healthz') {
    return next()
  }

  res.setHeader('Cache-Control', 'no-store')
  return res.status(200).json(healthzPayload)
}
