export type MenuOption = {
  id: string
  name: string
  priceCents: number | null
  isAvailable: boolean
  /** FLAVOR: preço por id da opção de variação */
  variationPrices?: Record<string, number>
}
export type MenuGroup = {
  id: string
  name: string
  type: 'VARIATION' | 'ADDON' | 'FLAVOR'
  minSelect: number
  maxSelect: number
  options: MenuOption[]
}
export type MenuProduct = {
  id: string
  name: string
  basePriceCents: number
  isAvailable: boolean
  groups: MenuGroup[]
}

export type Selection = { groupId: string; optionIds: string[] }
export type PriceResult = { ok: true; totalCents: number } | { ok: false; error: string }

/**
 * Preço de 1 unidade validando a seleção contra o produto.
 * VARIATION substitui base; FLAVOR = max(matriz[variação] → preço → variação/base); ADDON soma.
 */
export function calcItemPrice(product: MenuProduct, selections: Selection[]): PriceResult {
  if (!product.isAvailable) return { ok: false, error: 'Produto indisponível' }

  const byGroup = new Map<string, string[]>()
  for (const s of selections) {
    if (byGroup.has(s.groupId)) return { ok: false, error: 'Grupo duplicado na seleção' }
    if (new Set(s.optionIds).size !== s.optionIds.length)
      return { ok: false, error: 'Opção duplicada' }
    byGroup.set(s.groupId, s.optionIds)
  }
  for (const gid of byGroup.keys()) {
    if (!product.groups.some((g) => g.id === gid)) return { ok: false, error: 'Grupo desconhecido' }
  }

  let variationOption: MenuOption | null = null
  const flavorOptions: MenuOption[] = []
  let addonsCents = 0

  for (const group of product.groups) {
    const chosenIds = byGroup.get(group.id) ?? []
    if (chosenIds.length < group.minSelect || chosenIds.length > group.maxSelect)
      return { ok: false, error: `Seleção inválida em ${group.name}` }
    const chosen: MenuOption[] = []
    for (const oid of chosenIds) {
      const opt = group.options.find((o) => o.id === oid)
      if (!opt) return { ok: false, error: 'Opção inexistente' }
      if (!opt.isAvailable) return { ok: false, error: `${opt.name} indisponível` }
      chosen.push(opt)
    }
    if (group.type === 'VARIATION') variationOption = chosen[0] ?? null
    else if (group.type === 'FLAVOR') flavorOptions.push(...chosen)
    else for (const o of chosen) addonsCents += o.priceCents ?? 0
  }

  const variationPrice = variationOption?.priceCents ?? product.basePriceCents
  let productCents = variationPrice
  if (flavorOptions.length > 0) {
    productCents = Math.max(
      ...flavorOptions.map((f) => {
        const matrix = variationOption ? f.variationPrices?.[variationOption.id] : undefined
        return matrix ?? f.priceCents ?? variationPrice
      }),
    )
  }
  return { ok: true, totalCents: productCents + addonsCents }
}

/** Menor preço exibível ("a partir de"): menor variação disponível, senão base. */
export function minMenuPrice(product: MenuProduct): number {
  const variation = product.groups.find((g) => g.type === 'VARIATION')
  const prices = variation?.options
    .filter((o) => o.isAvailable && o.priceCents != null)
    .map((o) => o.priceCents!) ?? []
  return prices.length > 0 ? Math.min(...prices) : product.basePriceCents
}
