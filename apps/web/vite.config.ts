import { assertStagingPublicEnv } from '@delivery/shared/staging-env'
import { defineConfig, loadEnv } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_')
  assertStagingPublicEnv(mode, env, {
    VITE_API_URL: 'workers-url',
    VITE_TURNSTILE_SITE_KEY: 'non-empty',
  })
  return { plugins: [vue(), tailwindcss()] }
})
