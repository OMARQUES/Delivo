import { describe, expect, it } from 'vitest'
import { formatBRL, parseBRLToCents } from './money'

describe('formatBRL', () => {
  it('formats cents as R$ pt-BR', () => {
    expect(formatBRL(3550)).toBe('R$ 35,50')
    expect(formatBRL(0)).toBe('R$ 0,00')
    expect(formatBRL(100000)).toBe('R$ 1.000,00')
  })
})

describe('parseBRLToCents', () => {
  it('parses BR strings and numbers to cents', () => {
    expect(parseBRLToCents('35,50')).toBe(3550)
    expect(parseBRLToCents('35.50')).toBe(3550)
    expect(parseBRLToCents('1.234,56')).toBe(123456)
    expect(parseBRLToCents(12)).toBe(1200)
    expect(parseBRLToCents(12.5)).toBe(1250)
  })
  it('returns null for invalid/negative/absurd', () => {
    expect(parseBRLToCents('abc')).toBeNull()
    expect(parseBRLToCents('-5')).toBeNull()
    expect(parseBRLToCents('99999999')).toBeNull()
    expect(parseBRLToCents('')).toBeNull()
  })
})
