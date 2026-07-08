import {
  boolean, integer, pgEnum, pgTable, primaryKey, text, timestamp, uuid,
} from 'drizzle-orm/pg-core'
import { stores } from './stores'

export const optionGroupType = pgEnum('option_group_type', ['VARIATION', 'ADDON', 'FLAVOR'])

export const productCategories = pgTable('product_categories', {
  id: uuid('id').primaryKey().defaultRandom(),
  storeId: uuid('store_id').notNull().references(() => stores.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  sortIndex: integer('sort_index').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const products = pgTable('products', {
  id: uuid('id').primaryKey().defaultRandom(),
  storeId: uuid('store_id').notNull().references(() => stores.id, { onDelete: 'cascade' }),
  categoryId: uuid('category_id').notNull().references(() => productCategories.id, { onDelete: 'restrict' }),
  name: text('name').notNull(),
  description: text('description'),
  basePriceCents: integer('base_price_cents').notNull(),
  photoKey: text('photo_key'),
  isAvailable: boolean('is_available').notNull().default(true),
  sortIndex: integer('sort_index').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
})

export const optionGroups = pgTable('option_groups', {
  id: uuid('id').primaryKey().defaultRandom(),
  productId: uuid('product_id').notNull().references(() => products.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  type: optionGroupType('type').notNull(),
  minSelect: integer('min_select').notNull().default(0),
  maxSelect: integer('max_select').notNull().default(1),
  sortIndex: integer('sort_index').notNull().default(0),
})

export const options = pgTable('options', {
  id: uuid('id').primaryKey().defaultRandom(),
  groupId: uuid('group_id').notNull().references(() => optionGroups.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  priceCents: integer('price_cents'),
  isAvailable: boolean('is_available').notNull().default(true),
  sortIndex: integer('sort_index').notNull().default(0),
})

/** Matriz sabor×variação (só FLAVOR referencia VARIATION do mesmo produto) */
export const optionVariationPrices = pgTable(
  'option_variation_prices',
  {
    flavorOptionId: uuid('flavor_option_id').notNull().references(() => options.id, { onDelete: 'cascade' }),
    variationOptionId: uuid('variation_option_id').notNull().references(() => options.id, { onDelete: 'cascade' }),
    priceCents: integer('price_cents').notNull(),
  },
  (t) => [primaryKey({ columns: [t.flavorOptionId, t.variationOptionId] })],
)
