import { z } from 'zod'
import { PASSWORD_MAX_LENGTH, passwordPolicyIssue, type PasswordRole } from './password-policy'

/** Remove tudo que não é dígito — telefone BR armazenado como dígitos */
export function normalizePhone(raw: string): string {
  return raw.replace(/\D/g, '')
}

const TurnstileTokenValueSchema = z.string().trim().min(1).max(2048)

export const TurnstileTokenSchema = TurnstileTokenValueSchema.optional()

export const NormalizedEmail: z.ZodType<string> = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .pipe(z.email())

const PhoneSchema = z
  .string()
  .regex(/^[0-9+().\s-]+$/, 'Invalid phone characters')
  .transform(normalizePhone)
  .refine((phone) => phone.length >= 10 && phone.length <= 13, 'Invalid phone')

function registrationPasswordSchema(role: PasswordRole) {
  return z
    .string()
    .max(PASSWORD_MAX_LENGTH)
    .superRefine((password, context) => {
      const issue = passwordPolicyIssue(password, role)
      if (issue) context.addIssue({ code: 'custom', message: issue })
    })
}

const RegistrationBase = z.object({
  name: z.string().trim().min(2).max(120),
  email: NormalizedEmail,
  acceptedTerms: z.literal(true),
  turnstileToken: TurnstileTokenValueSchema,
})

const CustomerRegistration = RegistrationBase.extend({
  role: z.literal('CUSTOMER'),
  phone: PhoneSchema.optional(),
  password: registrationPasswordSchema('CUSTOMER'),
}).strict()

const DriverRegistration = RegistrationBase.extend({
  role: z.literal('DRIVER'),
  phone: PhoneSchema,
  password: registrationPasswordSchema('DRIVER'),
}).strict()

export const StartRegistrationSchema = z.discriminatedUnion('role', [
  CustomerRegistration,
  DriverRegistration,
])

export type StartRegistrationInput = z.infer<typeof StartRegistrationSchema>

export const ConfirmVerificationSchema = z
  .object({
    verificationId: z.uuid(),
    code: z.string().regex(/^\d{6}$/),
  })
  .strict()

export const ResendVerificationSchema = z
  .object({
    verificationId: z.uuid(),
    turnstileToken: TurnstileTokenSchema,
  })
  .strict()

export const RegisterSchema = StartRegistrationSchema
export type RegisterInput = z.infer<typeof RegisterSchema>

export const LoginSchema = z.object({
  identifier: z.string().trim().min(3).max(254),
  password: z.string().min(1).max(128),
  turnstileToken: TurnstileTokenSchema,
})
export type LoginInput = z.infer<typeof LoginSchema>

export const RefreshSchema = z.object({
  refreshToken: z.string().min(20).max(512),
})
export type RefreshInput = z.infer<typeof RefreshSchema>
