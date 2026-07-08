import { describe, expect, it } from 'vitest'
import { CategorySchema, ProductSchema, ProductUpdateSchema, OptionsTreeSchema } from './catalog.schema'

describe('CategorySchema', () => {
  it('accepts name, rejects empty/long', () => {
    expect(CategorySchema.parse({ name: 'Pizzas' }).name).toBe('Pizzas')
    expect(() => CategorySchema.parse({ name: '' })).toThrow()
    expect(() => CategorySchema.parse({ name: 'x'.repeat(61) })).toThrow()
  })
})

describe('ProductSchema', () => {
  const valid = { categoryId: crypto.randomUUID(), name: 'Pizza Calabresa', basePriceCents: 3500 }
  it('accepts minimal product, defaults isAvailable', () => {
    const p = ProductSchema.parse(valid)
    expect(p.isAvailable).toBe(true)
    expect(p.description).toBeUndefined()
  })
  it('rejects negative price and bad uuid', () => {
    expect(() => ProductSchema.parse({ ...valid, basePriceCents: -1 })).toThrow()
    expect(() => ProductSchema.parse({ ...valid, categoryId: 'nope' })).toThrow()
  })
})

describe('OptionsTreeSchema', () => {
  const variation = {
    name: 'Tamanho', type: 'VARIATION', minSelect: 1, maxSelect: 1,
    options: [{ name: 'P', priceCents: 3000 }, { name: 'G', priceCents: 5000 }],
  }
  const flavor = {
    name: 'Sabores', type: 'FLAVOR', minSelect: 1, maxSelect: 2,
    options: [{ name: 'Calabresa', priceCents: 5000 }, { name: 'Portuguesa', priceCents: 5500 }],
  }
  const addon = {
    name: 'Extras', type: 'ADDON', minSelect: 0, maxSelect: 3,
    options: [{ name: 'Borda recheada', priceCents: 800 }, { name: 'Catupiry', priceCents: 400 }],
  }

  it('accepts full tree', () => {
    const t = OptionsTreeSchema.parse([variation, flavor, addon])
    expect(t).toHaveLength(3)
    expect(t[0]!.options[0]!.isAvailable).toBe(true)
  })
  it('rejects VARIATION with min/max != 1 and two VARIATION groups', () => {
    expect(() => OptionsTreeSchema.parse([{ ...variation, maxSelect: 2 }])).toThrow()
    expect(() => OptionsTreeSchema.parse([variation, { ...variation, name: 'T2' }])).toThrow()
  })
  it('rejects two FLAVOR groups and min>max', () => {
    expect(() => OptionsTreeSchema.parse([flavor, { ...flavor, name: 'S2' }])).toThrow()
    expect(() => OptionsTreeSchema.parse([{ ...addon, minSelect: 5, maxSelect: 3 }])).toThrow()
  })
  it('accepts flavor variationPrices record', () => {
    const vid = crypto.randomUUID()
    const t = OptionsTreeSchema.parse([
      { ...flavor, options: [{ name: 'Calabresa', priceCents: null, variationPrices: { [vid]: 4000 } }] },
    ])
    expect(t[0]!.options[0]!.variationPrices).toEqual({ [vid]: 4000 })
  })
})

describe('ProductUpdateSchema', () => {
  it('empty object stays empty (no phantom isAvailable default)', () => {
    expect(ProductUpdateSchema.parse({})).toEqual({})
  })
  it('explicit isAvailable passes through', () => {
    expect(ProductUpdateSchema.parse({ isAvailable: false })).toEqual({ isAvailable: false })
  })
})
