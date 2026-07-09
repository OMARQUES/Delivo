import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { MenuProduct } from '@delivery/shared/constants'
import { useCartStore } from './cart'

const pizza: MenuProduct = {
  id: 'p1',
  name: 'Pizza',
  basePriceCents: 3000,
  isAvailable: true,
  groups: [{
    id: 'g1',
    name: 'Tamanho',
    type: 'VARIATION',
    minSelect: 1,
    maxSelect: 1,
    options: [{ id: 'o1', name: 'G', priceCents: 5000, isAvailable: true }],
  }],
}
const sel = [{ groupId: 'g1', optionIds: ['o1'] }]

beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.clear()
})

describe('cart store', () => {
  it('adds item with computed price + labels, accumulates totals', () => {
    const cart = useCartStore()
    const r = cart.addItem('pizzaria', 'Pizzaria', pizza, sel, 2, 'sem cebola')
    expect(r).toBe('added')
    expect(cart.items[0]).toMatchObject({ quantity: 2, unitPriceCents: 5000, name: 'Pizza' })
    expect(cart.items[0]!.optionLabels).toContain('Tamanho: G')
    expect(cart.subtotalCents).toBe(10000)
    expect(cart.count).toBe(2)
  })

  it('rejects invalid selection', () => {
    const cart = useCartStore()
    expect(cart.addItem('pizzaria', 'Pizzaria', pizza, [], 1)).toBe('invalid')
    expect(cart.items).toHaveLength(0)
  })

  it('different store returns other-store; clear() then allows', () => {
    const cart = useCartStore()
    cart.addItem('pizzaria', 'Pizzaria', pizza, sel, 1)
    expect(cart.addItem('mercado', 'Mercado', pizza, sel, 1)).toBe('other-store')
    cart.clear()
    expect(cart.addItem('mercado', 'Mercado', pizza, sel, 1)).toBe('added')
    expect(cart.storeSlug).toBe('mercado')
  })

  it('persists and hydrates from localStorage; remove/updateQty work', () => {
    const cart = useCartStore()
    cart.addItem('pizzaria', 'Pizzaria', pizza, sel, 1)
    setActivePinia(createPinia())
    const fresh = useCartStore()
    expect(fresh.items).toHaveLength(1)
    fresh.updateQty(fresh.items[0]!.uid, 3)
    expect(fresh.subtotalCents).toBe(15000)
    fresh.removeItem(fresh.items[0]!.uid)
    expect(fresh.items).toHaveLength(0)
  })
})
