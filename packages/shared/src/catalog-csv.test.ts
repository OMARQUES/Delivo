import { describe, expect, it } from 'vitest'
import { parseCatalogCsv } from './catalog-csv'

describe('parseCatalogCsv', () => {
  it('parses BR prices (comma and dot) into cents', () => {
    const r = parseCatalogCsv('Pizzas;Calabresa;Deliciosa;35,50\nBebidas;Coca 2L;;12.00')
    expect(r.errors).toHaveLength(0)
    expect(r.rows).toEqual([
      { category: 'Pizzas', name: 'Calabresa', description: 'Deliciosa', priceCents: 3550 },
      { category: 'Bebidas', name: 'Coca 2L', description: null, priceCents: 1200 },
    ])
  })
  it('skips header line if present and blank lines', () => {
    const r = parseCatalogCsv('categoria;nome;descricao;preco\n\nPizzas;Mussarela;;30,00\n')
    expect(r.rows).toHaveLength(1)
  })
  it('reports per-line errors without aborting', () => {
    const r = parseCatalogCsv('Pizzas;SemPreco;;\n;SemCategoria;;10,00\nPizzas;Ok;;9,90')
    expect(r.rows).toHaveLength(1)
    expect(r.errors).toHaveLength(2)
    expect(r.errors[0]!.line).toBe(1)
  })
  it('rejects absurd prices', () => {
    const r = parseCatalogCsv('X;Caro;;100000,00')
    expect(r.errors).toHaveLength(1)
  })
})
