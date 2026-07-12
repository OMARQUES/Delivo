import { createRoute, z } from '@hono/zod-openapi'
import { HTTPException } from 'hono/http-exception'
import {
  ConfirmVerificationSchema,
  LoginSchema,
  RefreshSchema,
  RegisterSchema,
  ResendVerificationSchema,
} from '@delivery/shared/schemas'
import type { Context } from 'hono'
import { createRouter } from '../app-factory'
import type { AppContext } from '../env'
import { createResendSender } from '../email/resend-sender'
import { resolveEmailConfig } from '../email/config'
import { dispatchOutboxById } from '../email/outbox.service'
import { authMiddleware } from '../middleware/auth'
import { AuthError, loginUser, rotateRefreshToken } from '../services/auth.service'
import {
  confirmRegistration,
  RegistrationError,
  registrationFlowEmail,
  resendRegistrationVerification,
  startRegistration,
  type IdentityContext,
} from '../services/registration.service'
import { revokeAllSessions, revokeSessionFamily } from '../services/security-session.service'
import {
  clearLoginFailures,
  protectLogin,
  protectRefresh,
  protectRegistration,
  recordLoginFailure,
} from '../security/auth-abuse'
import { protectCodeAttempt, protectCodeSend } from '../security/identity-abuse'
import {
  CODE_INVALID_OR_EXPIRED_MESSAGE,
  EMAIL_DELIVERY_UNAVAILABLE_MESSAGE,
  FLOW_INVALID_OR_EXPIRED_MESSAGE,
  SecurityHttpError,
} from '../security/http'

export const authRoutes = createRouter()

const UserShape = z.object({
  id: z.string(),
  name: z.string(),
  role: z.enum(['CUSTOMER', 'STORE', 'DRIVER', 'ADMIN']),
  status: z.enum(['ACTIVE', 'PENDING_EMAIL', 'PENDING_APPROVAL', 'BLOCKED']),
  phone: z.string().nullable(),
  email: z.email(),
})
const TokenResponse = z.object({
  user: UserShape,
  accessToken: z.string(),
  refreshToken: z.string(),
})
const FlowShape = z.object({
  verificationId: z.uuid(),
  expiresAt: z.iso.datetime(),
  resendAt: z.iso.datetime(),
})
const ConfirmationShape = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('CUSTOMER_SESSION'), user: UserShape, accessToken: z.string(), refreshToken: z.string() }),
  z.object({ kind: z.literal('DRIVER_PENDING_APPROVAL'), user: UserShape }),
])

function rethrow(e: unknown): never {
  if (e instanceof AuthError) throw new HTTPException(e.status, { message: e.message })
  if (e instanceof RegistrationError) {
    const message = e.code === 'CODE_INVALID_OR_EXPIRED'
      ? CODE_INVALID_OR_EXPIRED_MESSAGE
      : FLOW_INVALID_OR_EXPIRED_MESSAGE
    throw new SecurityHttpError(400, e.code, message)
  }
  throw e
}

function requireAuthCodeSecret(c: Context<AppContext>): string {
  const secret = c.env.AUTH_CODE_SECRET?.trim()
  if (!secret) {
    throw new SecurityHttpError(503, 'EMAIL_DELIVERY_UNAVAILABLE', EMAIL_DELIVERY_UNAVAILABLE_MESSAGE)
  }
  return secret
}

function identityContext(c: Context<AppContext>, authCodeSecret: string): IdentityContext {
  return {
    authCodeSecret,
    jwtSecret: c.env.JWT_SECRET,
    requestId: c.get('requestId'),
  }
}

function emailDelivery(c: Context<AppContext>) {
  try {
    const config = resolveEmailConfig(c.env)
    return { config, authCodeSecret: requireAuthCodeSecret(c) }
  } catch (error) {
    if (error instanceof SecurityHttpError) throw error
    throw new SecurityHttpError(503, 'EMAIL_DELIVERY_UNAVAILABLE', EMAIL_DELIVERY_UNAVAILABLE_MESSAGE)
  }
}

function syntheticRateLimitEmail(verificationId: string): string {
  return `flow-${verificationId}@invalid.local`
}

authRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/auth/register',
    request: { body: { content: { 'application/json': { schema: RegisterSchema } } } },
    responses: { 202: { description: 'Verificação iniciada', content: { 'application/json': { schema: FlowShape } } } },
  }),
  async (c) => {
    const input = c.req.valid('json')
    await protectRegistration(c, input)
    const email = emailDelivery(c)
    const started = await startRegistration(c.get('db'), input, identityContext(c, email.authCodeSecret))
    if (started.outboxId) {
      await dispatchOutboxById(
        c.get('db'),
        createResendSender(email.config),
        c.env,
        started.outboxId,
      ).catch(() => undefined)
    }
    return c.json(started.response, 202)
  },
)

authRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/auth/verification/confirm',
    request: { body: { content: { 'application/json': { schema: ConfirmVerificationSchema } } } },
    responses: { 200: { description: 'Email confirmado', content: { 'application/json': { schema: ConfirmationShape } } } },
  }),
  async (c) => {
    const input = c.req.valid('json')
    await protectCodeAttempt(c, 'REGISTRATION_VERIFY', input.verificationId)
    const result = await confirmRegistration(
      c.get('db'),
      input,
      identityContext(c, requireAuthCodeSecret(c)),
    ).catch(rethrow)
    return c.json(result, 200)
  },
)

authRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/auth/verification/resend',
    request: { body: { content: { 'application/json': { schema: ResendVerificationSchema } } } },
    responses: { 202: { description: 'Reenvio processado', content: { 'application/json': { schema: FlowShape } } } },
  }),
  async (c) => {
    const input = c.req.valid('json')
    const flowEmail = await registrationFlowEmail(c.get('db'), input.verificationId)
    await protectCodeSend(
      c,
      'REGISTRATION_VERIFY',
      flowEmail ?? syntheticRateLimitEmail(input.verificationId),
      input.verificationId,
      input.turnstileToken,
    )
    const email = emailDelivery(c)
    const resent = await resendRegistrationVerification(
      c.get('db'),
      input,
      identityContext(c, email.authCodeSecret),
    ).catch(rethrow)
    if (resent.outboxId) {
      await dispatchOutboxById(
        c.get('db'),
        createResendSender(email.config),
        c.env,
        resent.outboxId,
      ).catch(() => undefined)
    }
    return c.json({
      verificationId: resent.verificationId,
      expiresAt: resent.expiresAt,
      resendAt: resent.resendAt,
    }, 202)
  },
)

authRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/auth/login',
    request: { body: { content: { 'application/json': { schema: LoginSchema } } } },
    responses: { 200: { description: 'OK', content: { 'application/json': { schema: TokenResponse } } } },
  }),
  async (c) => {
    const input = c.req.valid('json')
    await protectLogin(c, input)
    try {
      const result = await loginUser(c.get('db'), input, c.env.JWT_SECRET)
      await clearLoginFailures(c, input.email)
      return c.json(result, 200)
    } catch (e) {
      if (e instanceof AuthError && e.status === 401) await recordLoginFailure(c, input.email)
      rethrow(e)
    }
  },
)

authRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/auth/refresh',
    request: { body: { content: { 'application/json': { schema: RefreshSchema } } } },
    responses: { 200: { description: 'OK', content: { 'application/json': { schema: TokenResponse } } } },
  }),
  async (c) => {
    const { refreshToken } = c.req.valid('json')
    await protectRefresh(c, refreshToken)
    const result = await rotateRefreshToken(c.get('db'), refreshToken, c.env.JWT_SECRET).catch(rethrow)
    return c.json(result, 200)
  },
)

authRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/auth/logout',
    middleware: [authMiddleware] as const,
    responses: { 204: { description: 'Sessão encerrada' } },
  }),
  async (c) => {
    await revokeSessionFamily(c.get('db'), c.get('auth')!.sessionFamilyId)
    return c.body(null, 204)
  },
)

authRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/auth/logout-all',
    middleware: [authMiddleware] as const,
    responses: { 204: { description: 'Todas as sessões encerradas' } },
  }),
  async (c) => {
    await revokeAllSessions(c.get('db'), c.get('auth')!.sub)
    return c.body(null, 204)
  },
)

authRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/auth/me',
    middleware: [authMiddleware] as const,
    responses: {
      200: {
        description: 'Usuário atual',
        content: { 'application/json': { schema: z.object({ sub: z.string(), role: z.string(), name: z.string() }) } },
      },
    },
  }),
  (c) => {
    const auth = c.get('auth')!
    return c.json({ sub: auth.sub, role: auth.role, name: auth.name }, 200)
  },
)
