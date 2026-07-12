import { OpenAPIHono } from '@hono/zod-openapi'
import type { Hook } from '@hono/zod-openapi'
import type { AppContext } from './env'

// Unified validation-error envelope: zod failures become 400 {error, issues}
// instead of the library default {success:false, error} that bypasses onError.
export const defaultHook: Hook<unknown, AppContext, string, unknown> = (result, c) => {
  if (!result.success) {
    if (result.error.issues.some((issue) => issue.message.startsWith('PASSWORD_'))) {
      return c.json({
        error: 'A senha não atende à política de segurança.',
        code: 'PASSWORD_POLICY_REJECTED',
      }, 400)
    }
    return c.json({ error: 'Validation failed', issues: result.error.issues }, 400)
  }
}

// Every route module MUST create its sub-app through this factory so the
// defaultHook applies. `new OpenAPIHono()` without it silently bypasses the
// unified error contract.
export function createRouter() {
  return new OpenAPIHono<AppContext>({ defaultHook })
}
