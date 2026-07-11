export type OfferRecurrence =
  | { kind: 'DATES'; dates: string[] }
  | { kind: 'WEEKLY'; days: number[] }
export type ScheduleWindow = { start: string; end: string }
export type ScheduleItem = ({ dow: number } | { date: string }) & ScheduleWindow
export type OfferSchedule = ScheduleWindow & { recurrence: OfferRecurrence }

const DAY = 1440
const timeMinutes = (value: string) => {
  const [hours, minutes] = value.split(':').map(Number)
  return hours! * 60 + minutes!
}
function interval(day: number, window: ScheduleWindow): [number, number] {
  const start = day * DAY + timeMinutes(window.start)
  let end = day * DAY + timeMinutes(window.end)
  if (end <= start) end += DAY
  return [start, end]
}
const overlaps = (a: [number, number], b: [number, number]) => a[0] < b[1] && b[0] < a[1]

/** Compara janelas iniciadas no mesmo dia, incluindo a cauda overnight. */
export function windowsOverlap(a: ScheduleWindow, b: ScheduleWindow) {
  return overlaps(interval(0, a), interval(0, b))
    || overlaps(interval(0, a), interval(-1, b))
    || overlaps(interval(-1, a), interval(0, b))
}
/** Cálculo civil: Date.UTC impede o fuso do runtime de mudar o dia. */
export function dateToDowSP(date: string) {
  const [year, month, day] = date.split('-').map(Number)
  return new Date(Date.UTC(year!, month! - 1, day!)).getUTCDay()
}
function civilDay(date: string) {
  const [year, month, day] = date.split('-').map(Number)
  return Math.floor(Date.UTC(year!, month! - 1, day!) / 86_400_000)
}
export function offerOccursOnDow(recurrence: OfferRecurrence, dow: number) {
  return recurrence.kind === 'WEEKLY' ? recurrence.days.includes(dow) : recurrence.dates.some((date) => dateToDowSP(date) === dow)
}
export function offerDates(recurrence: OfferRecurrence) {
  return recurrence.kind === 'DATES' ? [...recurrence.dates] : []
}
export function offerScheduleItems(offer: OfferSchedule): ScheduleItem[] {
  return offer.recurrence.kind === 'WEEKLY'
    ? offer.recurrence.days.map((dow) => ({ dow, start: offer.start, end: offer.end }))
    : offer.recurrence.dates.map((date) => ({ date, start: offer.start, end: offer.end }))
}
function itemIntervals(item: ScheduleItem, anchor?: number): [number, number][] {
  if ('date' in item) return [interval(civilDay(item.date), item)]
  if (anchor == null) return [-7, 0, 7].map((week) => interval(week + item.dow, item))
  const anchorDow = new Date(anchor * 86_400_000).getUTCDay()
  const sameWeek = anchor - anchorDow + item.dow
  return [-7, 0, 7].map((offset) => interval(sameWeek + offset, item))
}
function itemsConflict(a: ScheduleItem, b: ScheduleItem) {
  const anchor = 'date' in a ? civilDay(a.date) : 'date' in b ? civilDay(b.date) : undefined
  return itemIntervals(a, anchor).some((left) => itemIntervals(b, anchor).some((right) => overlaps(left, right)))
}
/** Overnight ocupa o dia adjacente; bordas são semiabertas e não conflitam. */
export function scheduleConflicts(existing: ScheduleItem[], offer: OfferSchedule) {
  const offered = offerScheduleItems(offer)
  return existing.some((item) => offered.some((candidate) => itemsConflict(item, candidate)))
}
