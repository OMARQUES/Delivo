export type StagingEnvRequirement = 'non-empty' | 'workers-url'

export function assertStagingPublicEnv(
  mode: string,
  env: Record<string, string>,
  requirements: Readonly<Record<string, StagingEnvRequirement>>,
): void {
  if (mode !== 'staging') return

  for (const [key, requirement] of Object.entries(requirements)) {
    const value = env[key]?.trim()
    if (!value) throw new Error(`Missing staging environment variable: ${key}`)
    if (requirement !== 'workers-url') continue

    let url: URL
    try {
      url = new URL(value)
    } catch {
      throw new Error(`Invalid staging workers.dev URL: ${key}`)
    }
    if (url.protocol !== 'https:' || !url.hostname.endsWith('.workers.dev')
      || url.username || url.password || url.port || url.search || url.hash || url.pathname !== '/') {
      throw new Error(`Invalid staging workers.dev URL: ${key}`)
    }
  }
}
