import { defineConfig } from 'vitest/config'

export default defineConfig({
  // Test files share one physical Postgres db; running them in parallel lets one
  // file's TRUNCATE wipe another's rows mid-test. Run files sequentially.
  test: { environment: 'node', globals: true, fileParallelism: false },
})
