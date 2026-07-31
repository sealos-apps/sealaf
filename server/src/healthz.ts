import { NextFunction, Request, Response } from 'express'
import { ServerConfig } from './constants'
import { SystemDatabase } from './system-database'

export const healthzPayload = {
  service: 'sealaf',
  status: 'ok',
} as const

type HealthzIssue = {
  key: string
  message: string
}

type HealthzResponse = {
  service: 'sealaf'
  status: 'ok' | 'error'
  issues?: HealthzIssue[]
}

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

function readRequiredConfig(
  key: string,
  getter: () => string | undefined,
  issues: HealthzIssue[],
) {
  try {
    const value = getter()
    if (!value || !value.trim()) {
      issues.push({ key, message: 'missing required config' })
    }
  } catch {
    issues.push({ key, message: 'missing required config' })
  }
}

function collectConfigIssues() {
  const issues: HealthzIssue[] = []

  readRequiredConfig('DATABASE_URL', () => ServerConfig.DATABASE_URL, issues)
  readRequiredConfig('JWT_SECRET', () => ServerConfig.JWT_SECRET, issues)
  readRequiredConfig(
    'DEFAULT_REGION_RUNTIME_DOMAIN',
    () => ServerConfig.DEFAULT_REGION_RUNTIME_DOMAIN,
    issues,
  )

  const rawTlsEnabled = process.env.DEFAULT_REGION_TLS_ENABLED
  if (
    rawTlsEnabled !== undefined &&
    rawTlsEnabled !== 'true' &&
    rawTlsEnabled !== 'false'
  ) {
    issues.push({
      key: 'DEFAULT_REGION_TLS_ENABLED',
      message: 'must be true or false',
    })
  }

  if (
    ServerConfig.DEFAULT_REGION_TLS_ENABLED &&
    !ServerConfig.DEFAULT_REGION_TLS_WILDCARD_CERTIFICATE_SECRET_NAME?.trim()
  ) {
    issues.push({
      key: 'DEFAULT_REGION_TLS_WILDCARD_CERTIFICATE_SECRET_NAME',
      message: 'required when DEFAULT_REGION_TLS_ENABLED=true',
    })
  }

  return issues
}

async function collectHealthzIssues() {
  const issues = collectConfigIssues()

  try {
    await withTimeout(SystemDatabase.db.command({ ping: 1 }), HEALTHZ_TIMEOUT_MS)
  } catch {
    issues.push({
      key: 'DATABASE_PING',
      message: 'system database is unreachable',
    })
  }

  return issues
}

function respondHealthz(res: Response, issues: HealthzIssue[]) {
  res.setHeader('Cache-Control', 'no-store')
  const payload: HealthzResponse =
    issues.length === 0
      ? healthzPayload
      : {
          service: 'sealaf',
          status: 'error',
          issues,
        }

  return res.status(issues.length === 0 ? 200 : 503).json(payload)
}

export async function healthzMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  if (req.method !== 'GET' || req.path !== '/healthz') {
    return next()
  }

  const issues = await collectHealthzIssues()
  return respondHealthz(res, issues)
}
