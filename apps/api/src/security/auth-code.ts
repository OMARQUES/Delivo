import type { AuthChallengePurpose } from '../db/schema'

const encoder = new TextEncoder()
const CODE_SPACE = 1_000_000
const UINT32_LIMIT = Math.floor(2 ** 32 / CODE_SPACE) * CODE_SPACE

export type AuthCodeContext = { challengeId: string; purpose: AuthChallengePurpose }

type HmacBytes = (counter: number) => Promise<Uint8Array>

function toB64url(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromB64url(s: string): Uint8Array | null {
  try {
    const padded = s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=')
    const bin = atob(padded)
    return Uint8Array.from(bin, (c) => c.charCodeAt(0))
  } catch {
    return null
  }
}

async function importHmacKey(secret: string) {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
}

async function hmac(secret: string, input: string): Promise<Uint8Array> {
  const key = await importHmacKey(secret)
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(input))
  return new Uint8Array(sig)
}

function readUint32(bytes: Uint8Array, offset: number): number | null {
  if (offset + 4 > bytes.length) return null
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, false)
}

export async function __testOnlyDeriveSixDigitCode(source: HmacBytes): Promise<string> {
  for (let counter = 0; counter < 1024; counter++) {
    const bytes = await source(counter)
    for (let offset = 0; offset + 4 <= bytes.length; offset += 4) {
      const value = readUint32(bytes, offset)
      if (value === null || value >= UINT32_LIMIT) continue
      return String(value % CODE_SPACE).padStart(6, '0')
    }
  }
  throw new Error('Unable to derive unbiased auth code')
}

export async function deriveAuthCode(secret: string, context: AuthCodeContext): Promise<string> {
  return __testOnlyDeriveSixDigitCode((counter) => hmac(
    secret,
    `sec03a:code:derive:v1\0${context.purpose}\0${context.challengeId}\0${counter}`,
  ))
}

function assertSixDigitCode(code: string) {
  if (!/^\d{6}$/.test(code)) throw new Error('Auth code must be an exact six digit numeric string')
}

export async function hashAuthCode(
  secret: string,
  context: AuthCodeContext,
  code: string,
): Promise<string> {
  assertSixDigitCode(code)
  const digest = await hmac(secret, `sec03a:code:verify:v1\0${context.purpose}\0${context.challengeId}\0${code}`)
  return toB64url(digest)
}

function fixedTimeEqualB64url(actual: string, expected: string): boolean {
  const actualBytes = fromB64url(actual)
  const expectedBytes = fromB64url(expected)
  if (!actualBytes || !expectedBytes || actualBytes.length !== expectedBytes.length) return false
  let diff = 0
  for (let i = 0; i < actualBytes.length; i++) diff |= (actualBytes[i] ?? 0) ^ (expectedBytes[i] ?? 0)
  return diff === 0
}

export async function verifyAuthCode(
  secret: string,
  context: AuthCodeContext,
  code: string,
  expectedHash: string,
): Promise<boolean> {
  if (!/^\d{6}$/.test(code)) return false
  return fixedTimeEqualB64url(await hashAuthCode(secret, context, code), expectedHash)
}

export async function createActionTicket(secret: string): Promise<{ token: string; hash: string }> {
  const raw = crypto.getRandomValues(new Uint8Array(32))
  const token = toB64url(raw)
  return { token, hash: await hashActionTicket(secret, token) }
}

export async function hashActionTicket(secret: string, token: string): Promise<string> {
  const digest = await hmac(secret, `sec03a:ticket:v1\0${token}`)
  return toB64url(digest)
}
