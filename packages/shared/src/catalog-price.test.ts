import { describe, expect, it } from 'vitest'
import { calcItemPrice, minMenuPrice, type MenuProduct } from './catalog-price'

const P = 'var-p', G = 'var-g', CAL = 'fl-cal', PORT = 'fl-port', BORDA = 'ad-borda', CAT = 'ad-cat'

const pizza: MenuProduct = {
  id: 'prod-1', name: 'Pizza', basePriceCents: 3000, isAvailable: true,
  groups: [
    { id: 'g-var', name: 'Tamanho', type: 'VARIATION', minSelect: 1, maxSelect: 1,
      options: [
        { id: P, name: 'P', priceCents: 3000, isAvailable: true },
        { id: G, name: 'G', priceCents: 5000, isAvailable: true },
      ] },
    { id: 'g-fl', name: 'Sabores', type: 'FLAVOR', minSelect: 1, maxSelect: 2,
      options: [
        { id: CAL, name: 'Calabresa', priceCents: null, isAvailable: true, variationPrices: { [P]: 3200, [G]: 5200 } },
        { id: PORT, name: 'Portuguesa', priceCents: 6000, isAvailable: true },
      ] },
    { id: 'g-ad', name: 'Extras', type: 'ADDON', minSelect: 0, maxSelect: 2,
      options: [
        { id: BORDA, name: 'Borda', priceCents: 800, isAvailable: true },
        { id: CAT, name: 'Catupiry', priceCents: null, isAvailable: true },
      ] },
  ],
}

const simple: MenuProduct = { id: 'prod-2', name: 'Coca', basePriceCents: 1200, isAvailable: true, groups: [] }

function sel(groupId: string, ...optionIds: string[]) {
  return { groupId, optionIds }
}

describe('calcItemPrice', () => {
  it('simple product, no groups: base price', () => {
    expect(calcItemPrice(simple, [])).toEqual({ ok: true, totalCents: 1200 })
  })

  it('variation replaces base; flavor matrix price per size; highest flavor wins', () => {
    // G + Calabresa (matriz G=5200) + Portuguesa (fixo 6000) → max = 6000
    const r = calcItemPrice(pizza, [sel('g-var', G), sel('g-fl', CAL, PORT)])
    expect(r).toEqual({ ok: true, totalCents: 6000 })
  })

  it('flavor matrix fallback chain: matrix → option price → variation price', () => {
    // P + só Calabresa → matriz P=3200
    expect(calcItemPrice(pizza, [sel('g-var', P), sel('g-fl', CAL)])).toEqual({ ok: true, totalCents: 3200 })
    // sabor sem matriz nem preço → cai no preço da variação
    const noPrices: MenuProduct = {
      ...pizza,
      groups: pizza.groups.map((g) =>
        g.id === 'g-fl'
          ? { ...g, options: [{ id: 'fl-x', name: 'Mussarela', priceCents: null, isAvailable: true }] }
          : g,
      ),
    }
    expect(calcItemPrice(noPrices, [sel('g-var', G), sel('g-fl', 'fl-x')])).toEqual({ ok: true, totalCents: 5000 })
  })

  it('addons add on top; null addon price = free', () => {
    const r = calcItemPrice(pizza, [sel('g-var', P), sel('g-fl', CAL), sel('g-ad', BORDA, CAT)])
    expect(r).toEqual({ ok: true, totalCents: 3200 + 800 })
  })

  it('validates: missing required variation/flavor, over max, unknown option, unavailable option', () => {
    expect(calcItemPrice(pizza, [sel('g-fl', CAL)]).ok).toBe(false) // sem variação
    expect(calcItemPrice(pizza, [sel('g-var', P)]).ok).toBe(false) // sem sabor (min 1)
    expect(calcItemPrice(pizza, [sel('g-var', P), sel('g-fl', CAL, PORT), sel('g-ad', BORDA, CAT), sel('g-ad', BORDA)]).ok).toBe(false) // grupo duplicado na seleção
    expect(calcItemPrice(pizza, [sel('g-var', P, G), sel('g-fl', CAL)]).ok).toBe(false) // 2 variações
    expect(calcItemPrice(pizza, [sel('g-var', P), sel('g-fl', 'ghost')]).ok).toBe(false) // opção inexistente
    const paused: MenuProduct = {
      ...pizza,
      groups: pizza.groups.map((g) =>
        g.id === 'g-fl'
          ? { ...g, options: g.options.map((o) => (o.id === CAL ? { ...o, isAvailable: false } : o)) }
          : g,
      ),
    }
    expect(calcItemPrice(paused, [sel('g-var', P), sel('g-fl', CAL)]).ok).toBe(false) // opção indisponível
    expect(calcItemPrice({ ...pizza, isAvailable: false }, [sel('g-var', P), sel('g-fl', CAL)]).ok).toBe(false) // produto indisponível
  })

  it('duplicate optionIds within a selection rejected', () => {
    expect(calcItemPrice(pizza, [sel('g-var', P), sel('g-fl', CAL, CAL)]).ok).toBe(false)
  })
})

describe('minMenuPrice', () => {
  it('no groups → base; with variation → cheapest variation', () => {
    expect(minMenuPrice(simple)).toBe(1200)
    expect(minMenuPrice(pizza)).toBe(3000)
  })
})
