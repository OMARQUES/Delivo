import { describe, expect, it } from 'vitest'
import { datedScheduleExpiry, dateToDowSP, findStartOccurrence, offerDates, offerOccursOnDow, scheduleConflicts, schedulesConflict, windowsOverlap } from './offers'
describe('ofertas e conflitos', () => {
  it('expõe recorrência', () => {
    expect(offerOccursOnDow({ kind: 'WEEKLY', days: [1, 5] }, 5)).toBe(true)
    expect(offerDates({ kind: 'DATES', dates: ['2026-07-18'] })).toEqual(['2026-07-18'])
    expect(dateToDowSP('2026-07-13')).toBe(1)
  })
  it('trata sobreposição, borda e overnight', () => {
    expect(windowsOverlap({ start: '11:00', end: '15:00' }, { start: '13:00', end: '19:00' })).toBe(true)
    expect(windowsOverlap({ start: '11:00', end: '15:00' }, { start: '15:00', end: '19:00' })).toBe(false)
    expect(windowsOverlap({ start: '17:00', end: '03:00' }, { start: '01:00', end: '05:00' })).toBe(true)
  })
  it('detecta dow×dow, dow×data e data×data', () => {
    const agenda = [{ dow: 1, start: '11:00', end: '15:00' }]
    expect(scheduleConflicts(agenda, { recurrence: { kind: 'WEEKLY', days: [1] }, start: '13:00', end: '19:00' })).toBe(true)
    expect(scheduleConflicts(agenda, { recurrence: { kind: 'WEEKLY', days: [2] }, start: '13:00', end: '19:00' })).toBe(false)
    expect(scheduleConflicts(agenda, { recurrence: { kind: 'DATES', dates: ['2026-07-13'] }, start: '13:00', end: '19:00' })).toBe(true)
    expect(scheduleConflicts([{ date: '2026-07-18', start: '10:00', end: '14:00' }], { recurrence: { kind: 'DATES', dates: ['2026-07-18'] }, start: '12:00', end: '16:00' })).toBe(true)
  })
  it('compara a cauda overnight no dia adjacente', () => {
    expect(scheduleConflicts([{ dow: 1, start: '17:00', end: '03:00' }], { recurrence: { kind: 'WEEKLY', days: [2] }, start: '02:00', end: '05:00' })).toBe(true)
    expect(scheduleConflicts([{ date: '2026-07-13', start: '17:00', end: '03:00' }], { recurrence: { kind: 'DATES', dates: ['2026-07-14'] }, start: '03:00', end: '05:00' })).toBe(false)
  })
  it('compara duas agendas e mantém bordas semiabertas', () => {
    expect(schedulesConflict([{ dow: 1, start: '08:00', end: '12:00' }], [{ dow: 1, start: '11:00', end: '13:00' }])).toBe(true)
    expect(schedulesConflict([{ dow: 1, start: '08:00', end: '12:00' }], [{ dow: 1, start: '12:00', end: '13:00' }])).toBe(false)
    expect(schedulesConflict([], [{ dow: 1, start: '12:00', end: '13:00' }])).toBe(false)
  })
  it('aplica tolerância exata de ±30 minutos', () => {
    const schedule = [{ date: '2026-07-11', start: '10:00', end: '12:00' }]
    expect(findStartOccurrence(schedule, new Date('2026-07-11T12:30:00Z'))).not.toBeNull() // 09:30 SP
    expect(findStartOccurrence(schedule, new Date('2026-07-11T12:29:59Z'))).toBeNull()
    expect(findStartOccurrence(schedule, new Date('2026-07-11T13:30:00Z'))).not.toBeNull() // 10:30 SP
    expect(findStartOccurrence(schedule, new Date('2026-07-11T13:30:01Z'))).toBeNull()
  })
  it('expira vínculo datado no fim real da última janela overnight', () => {
    expect(datedScheduleExpiry([{ date: '2026-07-18', start: '23:00', end: '03:00' }]))
      .toEqual(new Date('2026-07-19T06:00:00.000Z'))
  })
})
