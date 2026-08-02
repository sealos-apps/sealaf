const mockCommand = jest.fn()

jest.mock('./system-database', () => ({
  SystemDatabase: {
    db: {
      command: mockCommand,
    },
  },
}))

import { healthzMiddleware, healthzPayload } from './healthz'

const ENV_KEYS = [
  'DATABASE_URL',
  'JWT_SECRET',
  'DEFAULT_REGION_RUNTIME_DOMAIN',
  'DEFAULT_REGION_TLS_ENABLED',
  'DEFAULT_REGION_TLS_WILDCARD_CERTIFICATE_SECRET_NAME',
] as const

type EnvKey = (typeof ENV_KEYS)[number]

function createResponse() {
  const headers = new Map<string, string>()
  return {
    statusCode: 0,
    body: undefined as unknown,
    headers,
    setHeader(key: string, value: string) {
      headers.set(key, value)
      return this
    },
    status(code: number) {
      this.statusCode = code
      return this
    },
    json(value: unknown) {
      this.body = value
      return this
    },
  }
}

function captureEnv() {
  return Object.fromEntries(
    ENV_KEYS.map((key) => [key, process.env[key]]),
  ) as Record<EnvKey, string | undefined>
}

function restoreEnv(snapshot: Record<EnvKey, string | undefined>) {
  for (const key of ENV_KEYS) {
    const value = snapshot[key]
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
}

function setHealthzEnv(overrides: Partial<Record<EnvKey, string>>) {
  const defaults: Record<EnvKey, string> = {
    DATABASE_URL: 'mongodb://127.0.0.1:27017/sealaf',
    JWT_SECRET: 'secret',
    DEFAULT_REGION_RUNTIME_DOMAIN: 'sealaf.example.com',
    DEFAULT_REGION_TLS_ENABLED: 'false',
    DEFAULT_REGION_TLS_WILDCARD_CERTIFICATE_SECRET_NAME: 'wildcard-cert',
  }

  for (const key of ENV_KEYS) {
    process.env[key] = overrides[key] ?? defaults[key]
  }
}

describe('healthzMiddleware', () => {
  let envSnapshot: Record<EnvKey, string | undefined>

  beforeEach(() => {
    envSnapshot = captureEnv()
    setHealthzEnv({})
    mockCommand.mockReset()
  })

  afterEach(() => {
    restoreEnv(envSnapshot)
  })

  it('returns the standard health contract for GET /healthz', async () => {
    mockCommand.mockResolvedValueOnce(undefined)
    const res = createResponse()
    const next = jest.fn()

    await healthzMiddleware(
      { method: 'GET', path: '/healthz' } as never,
      res as never,
      next,
    )

    expect(next).not.toHaveBeenCalled()
    expect(mockCommand).toHaveBeenCalledWith({ ping: 1 })
    expect(res.statusCode).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    expect(res.body).toEqual(healthzPayload)
  })

  it('returns missing required config when a necessary value is absent', async () => {
    delete process.env.JWT_SECRET
    mockCommand.mockResolvedValueOnce(undefined)
    const res = createResponse()
    const next = jest.fn()

    await healthzMiddleware(
      { method: 'GET', path: '/healthz' } as never,
      res as never,
      next,
    )

    expect(next).not.toHaveBeenCalled()
    expect(mockCommand).toHaveBeenCalledWith({ ping: 1 })
    expect(res.statusCode).toBe(503)
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    expect(res.body).toMatchObject({
      service: 'sealaf',
      status: 'error',
      issues: [
        {
          key: 'JWT_SECRET',
          message: 'missing required config',
        },
      ],
    })
  })

  it('returns a config issue when TLS is enabled without a wildcard secret', async () => {
    process.env.DEFAULT_REGION_TLS_ENABLED = 'true'
    delete process.env.DEFAULT_REGION_TLS_WILDCARD_CERTIFICATE_SECRET_NAME
    mockCommand.mockResolvedValueOnce(undefined)
    const res = createResponse()
    const next = jest.fn()

    await healthzMiddleware(
      { method: 'GET', path: '/healthz' } as never,
      res as never,
      next,
    )

    expect(next).not.toHaveBeenCalled()
    expect(mockCommand).toHaveBeenCalledWith({ ping: 1 })
    expect(res.statusCode).toBe(503)
    expect(res.body).toMatchObject({
      service: 'sealaf',
      status: 'error',
      issues: [
        {
          key: 'DEFAULT_REGION_TLS_WILDCARD_CERTIFICATE_SECRET_NAME',
          message: 'required when DEFAULT_REGION_TLS_ENABLED=true',
        },
      ],
    })
  })

  it('returns an error payload when the database ping fails', async () => {
    mockCommand.mockRejectedValueOnce(new Error('db down'))
    const res = createResponse()
    const next = jest.fn()

    await healthzMiddleware(
      { method: 'GET', path: '/healthz' } as never,
      res as never,
      next,
    )

    expect(next).not.toHaveBeenCalled()
    expect(mockCommand).toHaveBeenCalledWith({ ping: 1 })
    expect(res.statusCode).toBe(503)
    expect(res.body).toMatchObject({
      service: 'sealaf',
      status: 'error',
      issues: [
        {
          key: 'DATABASE_PING',
          message: 'system database is unreachable',
        },
      ],
    })
  })

  it('passes non-health requests to the next handler', async () => {
    const res = createResponse()
    const next = jest.fn()

    await healthzMiddleware(
      { method: 'GET', path: '/v1/regions' } as never,
      res as never,
      next,
    )

    expect(next).toHaveBeenCalledTimes(1)
    expect(res.statusCode).toBe(0)
  })
})
