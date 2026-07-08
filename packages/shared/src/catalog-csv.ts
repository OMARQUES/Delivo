export type CsvRow = { category: string; name: string; description: string | null; priceCents: number }
export type CsvError = { line: number; message: string }

/** "35,50" | "35.50" | "35" → centavos. null = inválido. */
function parsePriceBR(raw: string): number | null {
  const s = raw.trim().replace(/\./g, (m, i, str) => (str.indexOf(',') > -1 ? '' : m)).replace(',', '.')
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null
  const cents = Math.round(Number(s) * 100)
  if (!Number.isInteger(cents) || cents < 0 || cents > 1_000_000) return null
  return cents
}

/** Formato: categoria;nome;descricao;preco (preço em reais BR). Header opcional. */
export function parseCatalogCsv(text: string): { rows: CsvRow[]; errors: CsvError[] } {
  const rows: CsvRow[] = []
  const errors: CsvError[] = []
  const lines = text.split(/\r?\n/)
  lines.forEach((line, i) => {
    const n = i + 1
    const trimmed = line.trim()
    if (!trimmed) return
    if (i === 0 && /^categoria;/i.test(trimmed)) return // header
    const parts = trimmed.split(';')
    const [category, name, description, price] = [parts[0]?.trim(), parts[1]?.trim(), parts[2]?.trim(), parts[3]?.trim()]
    if (!category) return void errors.push({ line: n, message: 'categoria vazia' })
    if (!name) return void errors.push({ line: n, message: 'nome vazio' })
    const priceCents = price ? parsePriceBR(price) : null
    if (priceCents == null) return void errors.push({ line: n, message: 'preço inválido' })
    rows.push({ category, name, description: description || null, priceCents })
  })
  return { rows, errors }
}
