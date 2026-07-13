import { describe, expect, it } from 'vitest'
import { assertStagingPublicEnv } from './staging-env'

const requirements = {
  VITE_API_URL: 'workers-url',
  VITE_TURNSTILE_SITE_KEY: 'non-empty',
} as const

describe('assertStagingPublicEnv', () => {
  it('does nothing outside staging', () => {
    expect(() => assertStagingPublicEnv('production', {}, requirements)).not.toThrow()
  })

  it('rejects missing values and non-workers HTTPS origins', () => {
    expect(() => assertStagingPublicEnv('staging', {}, requirements)).toThrow(/VITE_API_URL/)
    expect(() => assertStagingPublicEnv('staging', {
      VITE_API_URL: 'http://localhost:8787',
      VITE_TURNSTILE_SITE_KEY: 'site-key',
    }, requirements)).toThrow(/workers.dev/)
  })

  it.each([
    'http://delivery-api-staging.example.workers.dev',
    'https://user:pass@delivery-api-staging.example.workers.dev',
    'https://delivery-api-staging.example.workers.dev:8443',
    'https://delivery-api-staging.example.workers.dev/path',
    'https://delivery-api-staging.example.workers.dev?debug=true',
    'https://delivery-api-staging.example.workers.dev#fragment',
  ])('rejects unsafe workers.dev URL %s', (url) => {
    expect(() => assertStagingPublicEnv('staging', {
      VITE_API_URL: url,
      VITE_TURNSTILE_SITE_KEY: 'site-key',
    }, requirements)).toThrow(/workers.dev/)
  })

  it('accepts complete workers.dev configuration', () => {
    expect(() => assertStagingPublicEnv('staging', {
      VITE_API_URL: 'https://delivery-api-staging.otavio-marques20.workers.dev',
      VITE_TURNSTILE_SITE_KEY: 'site-key',
    }, requirements)).not.toThrow()
  })
})
