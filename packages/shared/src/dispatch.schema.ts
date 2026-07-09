import { z } from 'zod'
import { DELIVERY_FAIL_REASONS } from './dispatch'

export const AvailabilitySchema = z.object({ isAvailable: z.boolean() })
export type AvailabilityInput = z.infer<typeof AvailabilitySchema>

export const DeliveryFailSchema = z.object({
  reason: z.enum(DELIVERY_FAIL_REASONS),
  note: z.string().trim().max(280).optional(),
})
export type DeliveryFailInput = z.infer<typeof DeliveryFailSchema>

export const FcmTokenSchema = z.object({ token: z.string().min(10).max(4096) })
export type FcmTokenInput = z.infer<typeof FcmTokenSchema>
