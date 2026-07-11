import { z } from 'zod'
const TimeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)
function todaySP() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
}
const DatesSchema = z.object({ kind: z.literal('DATES'), dates: z.array(z.iso.date()).min(1).max(30) }).superRefine(({ dates }, ctx) => {
  if (new Set(dates).size !== dates.length) ctx.addIssue({ code: 'custom', message: 'As datas não podem se repetir', path: ['dates'] })
  if (dates.some((date) => date < todaySP())) ctx.addIssue({ code: 'custom', message: 'As datas devem ser hoje ou futuras', path: ['dates'] })
})
const WeeklySchema = z.object({ kind: z.literal('WEEKLY'), days: z.array(z.number().int().min(0).max(6)).min(1).max(7) }).superRefine(({ days }, ctx) => {
  if (new Set(days).size !== days.length) ctx.addIssue({ code: 'custom', message: 'Os dias não podem se repetir', path: ['days'] })
})
export const OfferRecurrenceSchema = z.discriminatedUnion('kind', [DatesSchema, WeeklySchema])
export const OfferCreateSchema = z.object({
  dailyRateCents: z.number().int().min(0).max(1_000_000), perDeliveryCents: z.number().int().min(0).max(100_000),
  slots: z.number().int().min(1).max(20), recurrence: OfferRecurrenceSchema,
  start: TimeSchema, end: TimeSchema, note: z.string().trim().max(500).nullable().optional(),
})
export type OfferCreateInput = z.infer<typeof OfferCreateSchema>
