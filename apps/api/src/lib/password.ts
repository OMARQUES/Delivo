/**
 * PBKDF2 via WebCrypto — bcrypt/argon2 estouram o limite de CPU do Workers.
 * Formato: pbkdf2$<iterations>$<saltB64url>$<hashB64url>
 */
const ITERATIONS = 100_000
const KEY_BYTES = 32
const SALT_BYTES = 16

function toB64url(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromB64url(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'))
  return Uint8Array.from(bin, (c) => c.charCodeAt(0))
}

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  )
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations },
    key,
    KEY_BYTES * 8,
  )
  return new Uint8Array(bits)
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES))
  const hash = await derive(password, salt, ITERATIONS)
  return `pbkdf2$${ITERATIONS}$${toB64url(salt)}$${toB64url(hash)}`
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  try {
    const [scheme, iterStr, saltB64, hashB64] = stored.split('$')
    if (scheme !== 'pbkdf2' || !iterStr || !saltB64 || !hashB64) return false
    const iterations = Number(iterStr)
    if (!Number.isInteger(iterations) || iterations < 1) return false
    const expected = fromB64url(hashB64)
    const actual = await derive(password, fromB64url(saltB64), iterations)
    if (actual.length !== expected.length) return false
    let diff = 0
    for (let i = 0; i < actual.length; i++) diff |= (actual[i] ?? 0) ^ (expected[i] ?? 0)
    return diff === 0
  } catch {
    return false
  }
}
