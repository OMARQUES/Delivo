const PROVIDER_AMOUNT = /^(0|[1-9]\d*)(\.\d{1,2})?$/
const MAX_SAFE_CENTS = Number.MAX_SAFE_INTEGER

export function parseProviderAmount(raw: string): number {
  if (typeof raw !== 'string' || !PROVIDER_AMOUNT.test(raw)) {
    throw new Error('Invalid provider amount')
  }

  const [whole, fraction = ''] = raw.split('.')
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'))
  if (!Number.isSafeInteger(cents) || cents < 0 || cents > MAX_SAFE_CENTS) {
    throw new Error('Invalid provider amount')
  }
  return cents
}

export function formatProviderAmount(cents: number): string {
  if (!Number.isSafeInteger(cents) || cents < 0) {
    throw new Error('Invalid amount cents')
  }
  const whole = Math.floor(cents / 100)
  const fraction = String(cents % 100).padStart(2, '0')
  return `${whole}.${fraction}`
}
