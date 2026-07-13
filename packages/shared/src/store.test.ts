import { describe, expect, it } from 'vitest'
import { RESERVED_SLUGS, STORE_CATEGORIES, slugify } from './store'
import { StoreCreateSchema, StoreUpdateSchema } from './store.schema'

describe('slugify', () => {
  it('normalizes names to url-safe slugs', () => {
    expect(slugify('Pizzaria do João!')).toBe('pizzaria-do-joao')
    expect(slugify('  Açaí & Cia  ')).toBe('acai-cia')
    expect(slugify('LOJA___teste--2')).toBe('loja-teste-2')
  })
})

describe('StoreCreateSchema', () => {
  const valid = {
    name: 'Pizzaria do João',
    slug: 'pizzaria-do-joao',
    category: 'PIZZARIA',
    phone: '(44) 3333-4444',
    city: 'Cidade Exemplo',
    addressText: 'Rua Central, 100',
    lat: -23.5,
    lng: -51.9,
    owner: { name: 'João', email: 'Joao@Email.com' },
  }

  it('accepts valid input, normalizes phone digits and owner email', () => {
    const r = StoreCreateSchema.parse(valid)
    expect(r.phone).toBe('4433334444')
    expect(r.owner.email).toBe('joao@email.com')
  })

  it('rejects owner passwords and unknown owner fields', () => {
    expect(() => StoreCreateSchema.parse({
      ...valid,
      owner: { ...valid.owner, password: 'admin-must-not-set-this' },
    })).toThrow()
    expect(() => StoreCreateSchema.parse({
      ...valid,
      owner: { ...valid.owner, role: 'ADMIN' },
    })).toThrow()
  })

  it('rejects reserved and malformed slugs', () => {
    for (const slug of ['admin', 'login', 'loja', 'api', 'Pizzaria!']) {
      expect(() => StoreCreateSchema.parse({ ...valid, slug })).toThrow()
    }
  })

  it('rejects unknown category and bad coords', () => {
    expect(() => StoreCreateSchema.parse({ ...valid, category: 'XYZ' })).toThrow()
    expect(() => StoreCreateSchema.parse({ ...valid, lat: 91 })).toThrow()
  })
})

describe('StoreUpdateSchema', () => {
  it('accepts partial config updates', () => {
    const r = StoreUpdateSchema.parse({
      deliveryFeeMode: 'DISTANCE',
      deliveryMinFeeCents: 400,
      deliveryPerKmCents: 150,
      deliveryMaxKm: 8,
      minOrderCents: 1500,
      deliveryEtaMinutes: [40, 60],
      pickupEtaMinutes: [15, 25],
      isPaused: true,
      openingHours: [{ dow: 5, open: '18:00', close: '23:30' }],
    })
    expect(r.deliveryFeeMode).toBe('DISTANCE')
  })

  it('rejects invalid opening hours and negative money', () => {
    expect(() => StoreUpdateSchema.parse({ openingHours: [{ dow: 7, open: '18:00', close: '23:00' }] })).toThrow()
    expect(() => StoreUpdateSchema.parse({ openingHours: [{ dow: 1, open: '25:00', close: '23:00' }] })).toThrow()
    expect(() => StoreUpdateSchema.parse({ minOrderCents: -1 })).toThrow()
    expect(() => StoreUpdateSchema.parse({ deliveryEtaMinutes: [60, 40] })).toThrow()
  })
})

describe('constants', () => {
  it('exposes categories with PT-BR labels and reserved slugs', () => {
    expect(STORE_CATEGORIES.PIZZARIA).toBe('Pizzaria')
    expect(RESERVED_SLUGS).toContain('admin')
    expect(RESERVED_SLUGS).toContain('cadastro')
  })
})
