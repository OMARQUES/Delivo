import {
  boolean, doublePrecision, integer, jsonb, pgEnum, pgTable, real, text,
  timestamp, uniqueIndex, uuid,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { users } from './users'

export const deliveryFeeMode = pgEnum('delivery_fee_mode', ['FIXED', 'DISTANCE'])
export const storeSecurityStatus = pgEnum('store_security_status', ['ACTIVE', 'SUSPENDED', 'CLOSED'])

export const stores = pgTable(
  'stores',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerUserId: uuid('owner_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    category: text('category').notNull(),
    phone: text('phone').notNull(),
    city: text('city').notNull(),
    addressText: text('address_text').notNull(),
    lat: doublePrecision('lat').notNull(),
    lng: doublePrecision('lng').notNull(),
    /** chave do objeto no R2 (logos/<uuid>) */
    logoKey: text('logo_key'),
    pixKey: text('pix_key'),
    /** basis points: 1000 = 10%; default 0 evita cobrança sem acordo */
    commissionBps: integer('commission_bps').notNull().default(0),
    deliveryFeeMode: deliveryFeeMode('delivery_fee_mode').notNull().default('FIXED'),
    deliveryFixedFeeCents: integer('delivery_fixed_fee_cents'),
    deliveryMinFeeCents: integer('delivery_min_fee_cents'),
    deliveryPerKmCents: integer('delivery_per_km_cents'),
    deliveryMaxKm: real('delivery_max_km'),
    minOrderCents: integer('min_order_cents'),
    /** [min,max] minutos */
    deliveryEtaMinutes: jsonb('delivery_eta_minutes').$type<[number, number] | null>(),
    pickupEtaMinutes: jsonb('pickup_eta_minutes').$type<[number, number] | null>(),
    /** [{dow,open,close}] */
    openingHours: jsonb('opening_hours').$type<{ dow: number; open: string; close: string }[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    isPaused: boolean('is_paused').notNull().default(false),
    securityStatus: storeSecurityStatus('security_status').notNull().default('ACTIVE'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex('stores_slug_unique').on(sql`lower(${t.slug})`),
    uniqueIndex('stores_owner_unique').on(t.ownerUserId),
  ],
)
