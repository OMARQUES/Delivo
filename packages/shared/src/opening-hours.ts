export type OpeningHour = { dow: number; open: string; close: string }

const TZ = 'America/Sao_Paulo'

/** dow (0=domingo) + minutos do dia no fuso de SP para um instante UTC */
function spDayMinutes(at: Date): { dow: number; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(at)
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? ''
  const dows = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const hour = Number(get('hour')) % 24 // Intl pode devolver '24' à meia-noite
  return { dow: dows.indexOf(get('weekday')), minutes: hour * 60 + Number(get('minute')) }
}

function toMin(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number)
  return (h ?? 0) * 60 + (m ?? 0)
}

/** Aberto agora? Janela com close < open atravessa a meia-noite (conta pro dow de abertura). */
export function isOpenNow(hours: OpeningHour[], now: Date = new Date()): boolean {
  const { dow, minutes } = spDayMinutes(now)
  const prevDow = (dow + 6) % 7
  return hours.some((h) => {
    const open = toMin(h.open)
    const close = toMin(h.close)
    if (close > open) return h.dow === dow && minutes >= open && minutes < close
    // overnight: [open..24h) no dia h.dow, [0..close) no dia seguinte
    if (h.dow === dow && minutes >= open) return true
    if (h.dow === prevDow && minutes < close) return true
    return false
  })
}
