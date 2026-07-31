import { NextFunction, Request, Response } from 'express'
import { SystemDatabase } from './system-database'

export const healthzPayload = {
  service: 'sealaf',
  status: 'ok',
} as const

export const healthzUnhealthyPayload = {
  service: 'sealaf',
  status: 'error',
} as const

const HEALTHZ_TIMEOUT_MS = 900

function withTimeout<T>(promise: Promise<T>, timeoutMs: number) {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`healthz timed out after ${timeoutMs}ms`))
    }, timeoutMs)
  })

  return Promise.race([
    promise.finally(() => {
      if (timer) {
        clearTimeout(timer)
      }
    }),
    timeout,
  ])
}

async function checkHealthz() {
  await withTimeout(SystemDatabase.db.command({ ping: 1 }), HEALTHZ_TIMEOUT_MS)
}

function respondHealthz(
  res: Response,
  statusCode: number,
  payload: typeof healthzPayload | typeof healthzUnhealthyPayload,
) {
  res.setHeader('Cache-Control', 'no-store')
  return res.status(statusCode).json(payload)
}

export async function healthzMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  if (req.method !== 'GET' || req.path !== '/healthz') {
    return next()
  }

  try {
    await checkHealthz()
    return respondHealthz(res, 200, healthzPayload)
  } catch {
    return respondHealthz(res, 503, healthzUnhealthyPayload)
  }
}
