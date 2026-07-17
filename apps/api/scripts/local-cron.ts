import { LOCAL_CRON_INTERVAL_MS, runLocalCronLoop } from '../src/dev/local-cron'

const controller = new AbortController()
const stop = () => controller.abort()
process.once('SIGINT', stop)
process.once('SIGTERM', stop)

console.log(`local_cron=STARTED interval_seconds=${LOCAL_CRON_INTERVAL_MS / 1000}`)
await runLocalCronLoop({
  signal: controller.signal,
  onStatus: status => console.log(`local_cron=${status}`),
})
console.log('local_cron=STOPPED')
