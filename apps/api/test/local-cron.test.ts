import { describe, expect, it, vi } from 'vitest'
import {
  LOCAL_CRON_INTERVAL_MS,
  LOCAL_CRON_URL,
  runLocalCronLoop,
  triggerLocalCron,
  type LocalCronStatus,
} from '../src/dev/local-cron'

describe('local cron runner', () => {
  it('triggers only the loopback scheduled endpoint and consumes the response body', async () => {
    const cancel = vi.fn(async () => {})
    const response = new Response(null, { status: 200 })
    Object.defineProperty(response, 'body', { value: { cancel } })
    const fetcher = vi.fn(async (input: string, init?: RequestInit) => {
      expect(input).toBe(LOCAL_CRON_URL)
      expect(init).toEqual({ method: 'GET' })
      return response
    })

    const status = await triggerLocalCron(fetcher)
    expect(status).toBe('TRIGGERED')
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('maps HTTP and connection failures without exposing response content', async () => {
    const http = vi.fn(async () => new Response('provider/order/token body', { status: 503 }))
    const unavailable = vi.fn(async () => { throw new Error('connection refused') })

    expect(await triggerLocalCron(http)).toBe('HTTP_ERROR')
    expect(await triggerLocalCron(unavailable)).toBe('API_UNAVAILABLE')
  })

  it('runs ticks sequentially and stops cleanly on abort', async () => {
    const controller = new AbortController()
    const statuses: LocalCronStatus[] = []
    const fetcher = vi.fn()
    const wait = vi.fn(async () => {})
    let active = 0
    let maxActive = 0
    fetcher.mockImplementation(async (_input: string, init?: RequestInit) => {
      expect(init?.signal).toBe(controller.signal)
      active += 1
      maxActive = Math.max(maxActive, active)
      await Promise.resolve()
      active -= 1
      if (fetcher.mock.calls.length === 3) controller.abort()
      return new Response(null, { status: 200 })
    })

    await runLocalCronLoop({ fetcher, wait, signal: controller.signal, onStatus: status => statuses.push(status) })

    expect(statuses).toEqual(['TRIGGERED', 'TRIGGERED', 'TRIGGERED'])
    expect(wait).toHaveBeenCalledTimes(2)
    expect(wait).toHaveBeenCalledWith(LOCAL_CRON_INTERVAL_MS, controller.signal)
    expect(maxActive).toBe(1)
  })

  it('aborts an in-flight scheduled request', async () => {
    const controller = new AbortController()
    const fetcher = vi.fn(async (_input: string, init?: RequestInit) => {
      expect(init?.signal).toBe(controller.signal)
      controller.abort()
      throw new DOMException('aborted', 'AbortError')
    })

    const statuses: LocalCronStatus[] = []
    await runLocalCronLoop({
      fetcher,
      signal: controller.signal,
      onStatus: status => statuses.push(status),
    })

    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(statuses).toEqual(['API_UNAVAILABLE'])
  })
})
