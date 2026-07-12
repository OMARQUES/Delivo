import { z } from 'zod'

/** Remove tudo que não é dígito — telefone BR armazenado como dígitos */
export function normalizePhone(raw: string): string {
  return raw.replace(/\D/g, '')
}

const TurnstileTokenSchema = z.string().trim().min(1).max(2048).optional()

export const RegisterSchema = z.object({
  name: z.string().trim().min(2).max(120),
  phone: z.string().transform(normalizePhone).pipe(z.string().min(10).max(13)),
  email: z.string().trim().toLowerCase().pipe(z.email()).optional(),
  password: z.string().min(8).max(128),
  role: z.enum(['CUSTOMER', 'DRIVER']).default('CUSTOMER'),
  acceptedTerms: z.literal(true),
  turnstileToken: TurnstileTokenSchema,
})
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
