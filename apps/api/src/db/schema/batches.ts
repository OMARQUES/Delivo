import { index, pgEnum, pgTable, timestamp, uuid } from 'drizzle-orm/pg-core'
import { BATCH_STATUSES } from '@delivery/shared/constants'
import { stores } from './stores'

export const batchStatus = pgEnum('batch_status', BATCH_STATUSES)

export const deliveryBatches = pgTable(
  'delivery_batches',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    storeId: uuid('store_id').notNull().references(() => stores.id, { onDelete: 'cascade' }),
    /** Entregador que aceitou o pacote (null enquanto OPEN/PENDING). */
    driverId: uuid('driver_id'),
    status: batchStatus('status').notNull().default('OPEN'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
  },
  (t) => [
    index('delivery_batches_store_status_idx').on(t.storeId, t.status),
    index('delivery_batches_status_idx').on(t.status),
  ],
)
