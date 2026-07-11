import { describe, expect, it } from 'vitest'
import { DriverScheduleSchema } from './store-driver.schema'

describe('DriverScheduleSchema', () => {
  it('aceita vínculo sem agenda e agendas homogêneas', () => {
    expect(DriverScheduleSchema.safeParse([]).success).toBe(true)
    expect(DriverScheduleSchema.safeParse([{ dow: 1, start: '08:00', end: '12:00' }]).success).toBe(true)
    expect(DriverScheduleSchema.safeParse([{ date: '2026-07-18', start: '08:00', end: '12:00' }]).success).toBe(true)
  })
  it('rejeita mistura, dia repetido e sobreposição overnight interna', () => {
    expect(DriverScheduleSchema.safeParse([{ dow: 1, start: '08:00', end: '12:00' }, { date: '2026-07-18', start: '13:00', end: '14:00' }]).success).toBe(false)
    expect(DriverScheduleSchema.safeParse([{ dow: 1, start: '08:00', end: '12:00' }, { dow: 1, start: '13:00', end: '14:00' }]).success).toBe(false)
    expect(DriverScheduleSchema.safeParse([{ dow: 1, start: '23:00', end: '03:00' }, { dow: 2, start: '02:00', end: '04:00' }]).success).toBe(false)
  })
})
