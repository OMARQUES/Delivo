import { describe, expect, it } from 'vitest'
import { isOpenNow, type OpeningHour } from './opening-hours'

// Datas em UTC; America/Sao_Paulo = UTC-3.
// 2026-07-08 é uma quarta-feira (dow 3).
const wed20h = new Date('2026-07-08T23:00:00Z') // 20:00 em SP, quarta
const wed23h30 = new Date('2026-07-09T02:30:00Z') // 23:30 em SP, ainda quarta
const thu01h = new Date('2026-07-09T04:00:00Z') // 01:00 em SP, quinta

const hours: OpeningHour[] = [{ dow: 3, open: '18:00', close: '23:00' }]

describe('isOpenNow', () => {
  it('open within window, closed outside', () => {
    expect(isOpenNow(hours, wed20h)).toBe(true)
    expect(isOpenNow(hours, wed23h30)).toBe(false)
  })

  it('closed on days without entries', () => {
    expect(isOpenNow(hours, thu01h)).toBe(false)
  })

  it('overnight window (close < open) spans midnight', () => {
    const overnight: OpeningHour[] = [{ dow: 3, open: '22:00', close: '02:00' }]
    expect(isOpenNow(overnight, wed23h30)).toBe(true) // 23:30 de quarta
    expect(isOpenNow(overnight, thu01h)).toBe(true) // 01:00 de quinta conta pro turno de quarta
    expect(isOpenNow(overnight, wed20h)).toBe(false) // 20:00 antes de abrir
  })

  it('empty hours = always closed', () => {
    expect(isOpenNow([], wed20h)).toBe(false)
  })
})
