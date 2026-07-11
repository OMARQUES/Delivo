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

export function schedulesConflict(a: ScheduleItem[], b: ScheduleItem[]) {
  return a.some((left) => b.some((right) => itemsConflict(left, right)))
}

export function scheduleHasInternalConflict(schedule: ScheduleItem[]) {
  return schedule.some((item, index) => schedule.slice(index + 1).some((other) => itemsConflict(item, other)))
}
/** Overnight ocupa o dia adjacente; bordas são semiabertas e não conflitam. */
export function scheduleConflicts(existing: ScheduleItem[], offer: OfferSchedule) {
  return schedulesConflict(existing, offerScheduleItems(offer))
}

export function saoPauloDate(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now)
}

export function addCivilDays(date: string, days: number) {
  return new Date((civilDay(date) + days) * 86_400_000).toISOString().slice(0, 10)
}

export type ScheduleOccurrence = { workDate: string; item: ScheduleItem; scheduledStartAt: Date; scheduledEndAt: Date }

export function occurrenceForWorkDate(schedule: ScheduleItem[], workDate: string): ScheduleOccurrence | null {
  const dow = dateToDowSP(workDate)
  const item = schedule.find((entry) => 'date' in entry ? entry.date === workDate : entry.dow === dow)
  if (!item) return null
  const scheduledStartAt = new Date(`${workDate}T${item.start}:00-03:00`)
  let endDate = workDate
  if (item.end <= item.start) endDate = addCivilDays(workDate, 1)
  const scheduledEndAt = new Date(`${endDate}T${item.end}:00-03:00`)
  return { workDate, item, scheduledStartAt, scheduledEndAt }
}

export function findStartOccurrence(schedule: ScheduleItem[], now = new Date(), toleranceMinutes = 30) {
  const today = saoPauloDate(now)
  const candidates = [-1, 0, 1]
    .map((offset) => occurrenceForWorkDate(schedule, addCivilDays(today, offset)))
    .filter((item): item is ScheduleOccurrence => item != null)
  return candidates.find((occurrence) => {
    const earliest = occurrence.scheduledStartAt.getTime() - toleranceMinutes * 60_000
    const latest = occurrence.scheduledStartAt.getTime() + toleranceMinutes * 60_000
    return now.getTime() >= earliest && now.getTime() <= latest && now < occurrence.scheduledEndAt
  }) ?? null
}

export function datedScheduleExpiry(schedule: ScheduleItem[]) {
  const dated = schedule.filter((item): item is Extract<ScheduleItem, { date: string }> => 'date' in item)
  if (!dated.length) return null
  return dated.map((item) => occurrenceForWorkDate([item], item.date)!.scheduledEndAt)
    .reduce((latest, current) => current > latest ? current : latest)
}
