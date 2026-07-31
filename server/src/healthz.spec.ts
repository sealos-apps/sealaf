const mockCommand = jest.fn()

jest.mock('./system-database', () => ({
  SystemDatabase: {
    db: {
      command: mockCommand,
    },
  },
}))

import {
  healthzMiddleware,
  healthzPayload,
  healthzUnhealthyPayload,
} from './healthz'

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

describe('healthzMiddleware', () => {
  beforeEach(() => {
    mockCommand.mockReset()
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
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    expect(res.body).toEqual(healthzUnhealthyPayload)
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
