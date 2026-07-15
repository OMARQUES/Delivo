const MAX_TOKEN_LENGTH = 256

function boundedAscii(value: string): boolean {
  return value.length > 0 && value.length <= MAX_TOKEN_LENGTH && /^[\x21-\x7e]+$/.test(value)
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(a) || !/^[0-9a-f]{64}$/.test(b)) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

async function hmacSha256Hex(secret: string, manifest: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(manifest))
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export async function verifyMercadoPagoSignature(input: {
  secret: string
  dataId: string
  requestId: string
  signature: string
}): Promise<{ valid: true; timestamp: string } | { valid: false }> {
  if (!input.secret || !boundedAscii(input.dataId) || !boundedAscii(input.requestId) || input.signature.length > MAX_TOKEN_LENGTH) return { valid: false }
  const parts = input.signature.split(',').map((part) => part.trim().split('='))
  const values = new Map(parts.filter((part): part is [string, string] => part.length === 2).map(([key, value]) => [key, value]))
  const timestamp = values.get('ts') ?? ''
  const signatureV1 = (values.get('v1') ?? '').toLowerCase()
  if (!/^\d{1,20}$/.test(timestamp) || !/^[0-9a-f]{64}$/.test(signatureV1)) return { valid: false }
  const expected = await hmacSha256Hex(input.secret, `id:${input.dataId};request-id:${input.requestId};ts:${timestamp};`)
  return timingSafeEqualHex(expected, signatureV1) ? { valid: true, timestamp } : { valid: false }
}
