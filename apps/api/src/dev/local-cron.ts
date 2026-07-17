export const LOCAL_CRON_URL = 'http://127.0.0.1:8787/__scheduled?cron=*%2F5+*+*+*+*'
export const LOCAL_CRON_INTERVAL_MS = 10_000

export type LocalCronStatus = 'TRIGGERED' | 'HTTP_ERROR' | 'API_UNAVAILABLE'
export type LocalCronFetch = (input: string, init?: RequestInit) => Promise<Response>
export type LocalCronWait = (milliseconds: number, signal: AbortSignal) => Promise<void>

export async function triggerLocalCron(fetcher: LocalCronFetch = fetch): Promise<LocalCronStatus> {
  try {
    const response = await fetcher(LOCAL_CRON_URL, { method: 'GET' })
    await response.body?.cancel()
    return response.ok ? 'TRIGGERED' : 'HTTP_ERROR'
  } catch {
    return 'API_UNAVAILABLE'
  }
}

export async function runLocalCronLoop(options: {
  fetcher?: LocalCronFetch
  wait?: LocalCronWait
  signal?: AbortSignal
  onStatus?: (status: LocalCronStatus) => void
} = {}): Promise<void> {
  const signal = options.signal ?? new AbortController().signal
  const fetcher = options.fetcher ?? fetch
  const wait = options.wait ?? waitForLocalCron

  while (!signal.aborted) {
    const status = await triggerLocalCron(fetcher)
    options.onStatus?.(status)
    if (signal.aborted) break
    await wait(LOCAL_CRON_INTERVAL_MS, signal)
  }
}

export const waitForLocalCron: LocalCronWait = (milliseconds, signal) => new Promise((resolve) => {
  if (signal.aborted) {
    resolve()
    return
  }

  const finish = () => {
    clearTimeout(timer)
    signal.removeEventListener('abort', finish)
    resolve()
  }
  const timer = setTimeout(finish, milliseconds)
  signal.addEventListener('abort', finish, { once: true })
})
