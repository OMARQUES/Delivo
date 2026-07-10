import { z } from 'zod'
import { normalizePhone } from './auth.schema'

const TimeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)
export const DriverScheduleSchema = z.array(z.object({
  dow: z.number().int().min(0).max(6),
  start: TimeSchema,
  end: TimeSchema,
})).max(14)

export const StoreDriverTermsSchema = z.object({
  dailyRateCents: z.number().int().min(0).max(1_000_000),
  perDeliveryCents: z.number().int().min(0).max(100_000),
  schedule: DriverScheduleSchema.default([]),
})

export const InviteStoreDriverSchema = StoreDriverTermsSchema.extend({
  phone: z.string().transform(normalizePhone).pipe(z.string().min(10).max(13)),
})

export const UpdateStoreDriverTermsSchema = StoreDriverTermsSchema.partial().refine(
  (value) => Object.keys(value).length > 0,
  'Informe ao menos um termo',
)

export const StartShiftSchema = z.object({
  storeId: z.uuid(),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
})

export const AdjustActiveShiftSchema = z.object({
  dailyRateCents: z.number().int().min(0).max(1_000_000).optional(),
  perDeliveryCents: z.number().int().min(0).max(100_000).optional(),
  applyRetroactive: z.boolean().optional(),
}).refine(
  (value) => value.dailyRateCents != null || value.perDeliveryCents != null || value.applyRetroactive === true,
  'Informe um novo valor ou solicite o ajuste retroativo',
)

export const SpecificDriverRequestSchema = z.object({ driverUserId: z.uuid() })

export const BatchBroadcastSchema = z.object({
  target: z.enum(['GENERAL', 'OWN', 'SPECIFIC']).default('GENERAL'),
  driverUserId: z.uuid().optional(),
}).refine(
  (value) => value.target !== 'SPECIFIC' || value.driverUserId != null,
  'Escolha o entregador específico',
)
