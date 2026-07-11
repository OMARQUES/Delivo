import { z } from 'zod'
import { DELIVERY_FAIL_REASONS } from './dispatch'

export const AvailabilitySchema = z.object({ isAvailable: z.boolean() })
export type AvailabilityInput = z.infer<typeof AvailabilitySchema>

export const DeliveryFailSchema = z.object({
  reason: z.enum(DELIVERY_FAIL_REASONS),
  note: z.string().trim().max(280).optional(),
})
export type DeliveryFailInput = z.infer<typeof DeliveryFailSchema>

export const DriverArrivalSchema = z.object({
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
}).refine((value) => (value.lat == null) === (value.lng == null), 'Informe latitude e longitude juntas')
export type DriverArrivalInput = z.infer<typeof DriverArrivalSchema>

export const FcmTokenSchema = z.object({ token: z.string().min(10).max(4096) })
export type FcmTokenInput = z.infer<typeof FcmTokenSchema>
