import { z } from 'zod'
import { NormalizedEmail } from './auth.schema'
import { scheduleHasInternalConflict } from './offers'

const TimeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)
const WeeklyScheduleItemSchema = z.object({ dow: z.number().int().min(0).max(6), start: TimeSchema, end: TimeSchema })
const DatedScheduleItemSchema = z.object({ date: z.iso.date(), start: TimeSchema, end: TimeSchema })
export const DriverScheduleSchema = z.array(z.union([WeeklyScheduleItemSchema, DatedScheduleItemSchema])).max(30).superRefine((schedule, ctx) => {
  const weekly = schedule.filter((item) => 'dow' in item)
  const dated = schedule.filter((item) => 'date' in item)
  if (weekly.length && dated.length) ctx.addIssue({ code: 'custom', message: 'A agenda não pode misturar dias semanais e datas específicas' })
  const keys = schedule.map((item) => 'dow' in item ? `dow:${item.dow}` : `date:${item.date}`)
  if (new Set(keys).size !== keys.length) ctx.addIssue({ code: 'custom', message: 'Use no máximo uma janela por dia ou data' })
  if (scheduleHasInternalConflict(schedule)) ctx.addIssue({ code: 'custom', message: 'A agenda possui horários sobrepostos' })
})

export const StoreDriverTermsSchema = z.object({
  dailyRateCents: z.number().int().min(0).max(1_000_000),
  perDeliveryCents: z.number().int().min(0).max(100_000),
  schedule: DriverScheduleSchema.default([]),
})

export const InviteStoreDriverSchema = StoreDriverTermsSchema.extend({
  email: NormalizedEmail,
}).strict()

export const UpdateStoreDriverTermsSchema = StoreDriverTermsSchema.partial().refine(
  (value) => Object.keys(value).length > 0,
  'Informe ao menos um termo',
)

export const StartShiftSchema = z.object({
  storeDriverId: z.uuid(),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
})

export const CreateShiftAuthorizationSchema = z.object({
  storeDriverId: z.uuid(),
  workDate: z.iso.date(),
  authorizedUntil: z.iso.datetime({ offset: true }),
  newEnd: TimeSchema.optional(),
  dailyRateCents: z.number().int().min(0).max(1_000_000).optional(),
  perDeliveryCents: z.number().int().min(0).max(100_000).optional(),
  note: z.string().trim().min(3).max(500),
})

export const ProposeActiveShiftTermsSchema = z.object({
  dailyRateCents: z.number().int().min(0).max(1_000_000),
  perDeliveryCents: z.number().int().min(0).max(100_000),
  applyRetroactive: z.boolean().default(false),
  note: z.string().trim().max(500).optional(),
})

export const RejectShiftDailySchema = z.object({
  reason: z.string().trim().min(3).max(500),
})

export const SpecificDriverRequestSchema = z.object({ driverUserId: z.uuid() })

export const BatchBroadcastSchema = z.object({
  target: z.enum(['GENERAL', 'OWN', 'SPECIFIC']).default('GENERAL'),
  driverUserId: z.uuid().optional(),
}).refine(
  (value) => value.target !== 'SPECIFIC' || value.driverUserId != null,
  'Escolha o entregador específico',
)
