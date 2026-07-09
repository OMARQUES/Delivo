const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' })
const NBSP = '\u00A0'

/** Centavos -> "R$ 35,50" */
export function formatBRL(cents: number): string {
  return brl.format(cents / 100).replace(new RegExp(NBSP, 'g'), ' ')
}

const MAX_CENTS = 1_000_000

/** "35,50" | "1.234,56" | "35.50" | 12.5 -> centavos. null = invalido. */
export function parseBRLToCents(input: string | number): number | null {
  let value: number
  if (typeof input === 'number') {
    value = input
  } else {
    const s = input.trim()
    if (!s) return null
    const normalized = s.includes(',') ? s.replace(/\./g, '').replace(',', '.') : s
    if (!/^\d+(\.\d{1,2})?$/.test(normalized)) return null
    value = Number(normalized)
  }
  if (!Number.isFinite(value) || value < 0) return null
  const cents = Math.round(value * 100)
  return cents > MAX_CENTS ? null : cents
}
