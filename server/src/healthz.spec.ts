import { healthzMiddleware, healthzPayload } from './healthz'

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
  it('returns the standard health contract for GET /healthz', () => {
    const res = createResponse()
    const next = jest.fn()

    healthzMiddleware(
      { method: 'GET', path: '/healthz' } as never,
      res as never,
      next,
    )

    expect(next).not.toHaveBeenCalled()
    expect(res.statusCode).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    expect(res.body).toEqual(healthzPayload)
  })

  it('passes non-health requests to the next handler', () => {
    const res = createResponse()
    const next = jest.fn()

    healthzMiddleware(
      { method: 'GET', path: '/v1/regions' } as never,
      res as never,
      next,
    )

    expect(next).toHaveBeenCalledTimes(1)
    expect(res.statusCode).toBe(0)
  })
})
