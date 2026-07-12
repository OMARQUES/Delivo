const encoder = new TextEncoder()

export type RateLimitSubjectKind = 'identity' | 'opaque'

function toBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function normalizeLoginKey(raw: string): string {
  const normalized = raw.trim().toLowerCase()
  return normalized.includes('@') ? normalized : normalized.replace(/\D/g, '')
}

export function normalizeRateLimitSubject(subject: string, subjectKind: RateLimitSubjectKind): string {
  return subjectKind === 'identity' ? normalizeLoginKey(subject) : subject
}

export async function hashRateLimitKey(
  secret: string,
  scope: string,
  subject: string,
  subjectKind: RateLimitSubjectKind,
): Promise<string> {
  const normalizedSubject = normalizeRateLimitSubject(subject, subjectKind)
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const digest = await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(`${scope}\0${normalizedSubject}`),
  )
  return toBase64Url(new Uint8Array(digest))
}
