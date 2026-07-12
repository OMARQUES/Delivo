import { z } from 'zod'
import { normalizePhone } from './auth.schema'

export const UpdateCustomerContactSchema = z.object({
  phone: z.string()
    .regex(/^[0-9+().\s-]+$/, 'Invalid phone characters')
    .transform(normalizePhone)
    .pipe(z.string().min(10).max(13))
    .nullable(),
}).strict()

export type UpdateCustomerContactInput = z.infer<typeof UpdateCustomerContactSchema>
