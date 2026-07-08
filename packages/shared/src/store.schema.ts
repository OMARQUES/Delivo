import { z } from 'zod'
import { normalizePhone } from './auth.schema'
import { RESERVED_SLUGS, STORE_CATEGORIES } from './store'

const SlugSchema = z
  .string()
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'Slug inválido')
  .min(3)
  .max(60)
  .refine((s) => !(RESERVED_SLUGS as readonly string[]).includes(s), 'Slug reservado')

const HourSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)
export const OpeningHoursSchema = z
  .array(
    z.object({
      dow: z.number().int().min(0).max(6), // 0=domingo
      open: HourSchema,
      close: HourSchema, // close < open = atravessa a meia-noite
    }),
  )
  .max(21)

const Cents = z.number().int().min(0).max(1_000_000)
const EtaRange = z.tuple([z.number().int().min(1).max(600), z.number().int().min(1).max(600)])

type StoreCategoryKey = keyof typeof STORE_CATEGORIES

export const StoreCreateSchema = z.object({
  name: z.string().trim().min(2).max(80),
  slug: SlugSchema,
  category: z.enum(Object.keys(STORE_CATEGORIES) as [StoreCategoryKey, ...StoreCategoryKey[]]),
  phone: z.string().transform(normalizePhone).pipe(z.string().min(10).max(13)),
  city: z.string().trim().min(2).max(80),
  addressText: z.string().trim().min(5).max(200),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  owner: z.object({
    name: z.string().trim().min(2).max(120),
    email: z.string().trim().toLowerCase().pipe(z.email()),
    password: z.string().min(8).max(128),
  }),
})
export type StoreCreateInput = z.infer<typeof StoreCreateSchema>

export const StoreUpdateSchema = z
  .object({
    name: z.string().trim().min(2).max(80),
    category: z.enum(Object.keys(STORE_CATEGORIES) as [StoreCategoryKey, ...StoreCategoryKey[]]),
    phone: z.string().transform(normalizePhone).pipe(z.string().min(10).max(13)),
    addressText: z.string().trim().min(5).max(200),
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
    deliveryFeeMode: z.enum(['FIXED', 'DISTANCE']),
    deliveryFixedFeeCents: Cents.nullable(),
    deliveryMinFeeCents: Cents.nullable(),
    deliveryPerKmCents: Cents.nullable(),
    deliveryMaxKm: z.number().min(0.5).max(100).nullable(),
    minOrderCents: Cents.nullable(),
    deliveryEtaMinutes: EtaRange.nullable(),
    pickupEtaMinutes: EtaRange.nullable(),
    isPaused: z.boolean(),
    openingHours: OpeningHoursSchema,
  })
  .partial()
export type StoreUpdateInput = z.infer<typeof StoreUpdateSchema>
