import { z } from 'zod'

const Cents = z.number().int().min(0).max(1_000_000)

export const CategorySchema = z.object({
  name: z.string().trim().min(1).max(60),
})
export type CategoryInput = z.infer<typeof CategorySchema>

export const ProductSchema = z.object({
  categoryId: z.uuid(),
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500).optional(),
  basePriceCents: Cents,
  isAvailable: z.boolean().default(true),
})
export type ProductInput = z.infer<typeof ProductSchema>

export const ProductUpdateSchema = ProductSchema.partial().extend({
  isAvailable: z.boolean().optional(),
  sortIndex: z.number().int().min(0).optional(),
})
export type ProductUpdateInput = z.infer<typeof ProductUpdateSchema>

const OptionInputSchema = z.object({
  name: z.string().trim().min(1).max(60),
  /** VARIATION: preço absoluto; ADDON: delta; FLAVOR: preço cheio (fallback). null = herda/grátis */
  priceCents: Cents.nullable().default(null),
  isAvailable: z.boolean().default(true),
  /** Só FLAVOR: preço por opção de variação (chave = índice da opção no grupo VARIATION desta árvore, ou uuid quando editando produto existente) */
  variationPrices: z.record(z.string(), Cents).optional(),
})

const GroupInputSchema = z.object({
  name: z.string().trim().min(1).max(60),
  type: z.enum(['VARIATION', 'ADDON', 'FLAVOR']),
  minSelect: z.number().int().min(0).max(20),
  maxSelect: z.number().int().min(1).max(20),
  options: z.array(OptionInputSchema).min(1).max(50),
})

export const OptionsTreeSchema = z
  .array(GroupInputSchema)
  .max(10)
  .refine((gs) => gs.every((g) => g.minSelect <= g.maxSelect), 'minSelect > maxSelect')
  .refine(
    (gs) => gs.every((g) => g.type !== 'VARIATION' || (g.minSelect === 1 && g.maxSelect === 1)),
    'VARIATION exige exatamente 1 escolha',
  )
  .refine((gs) => gs.filter((g) => g.type === 'VARIATION').length <= 1, 'Máximo 1 grupo VARIATION')
  .refine((gs) => gs.filter((g) => g.type === 'FLAVOR').length <= 1, 'Máximo 1 grupo FLAVOR')
export type OptionsTreeInput = z.infer<typeof OptionsTreeSchema>
