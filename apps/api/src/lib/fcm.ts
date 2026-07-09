type Payload = { title: string; body: string; data: Record<string, string> }

function b64url(data: Uint8Array | string): string {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function pemToPkcs8(pem: string): ArrayBuffer {
  const body = pem.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, '').replace(/\s/g, '')
  const bin = atob(body)
  const buf = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i)
  return buf.buffer
}

async function getAccessToken(clientEmail: string, privateKeyPem: string): Promise<string | null> {
  try {
    const now = Math.floor(Date.now() / 1000)
    const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
    const claims = b64url(JSON.stringify({
      iss: clientEmail,
      scope: 'https://www.googleapis.com/auth/firebase.messaging',
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600,
    }))
    const key = await crypto.subtle.importKey(
      'pkcs8',
      pemToPkcs8(privateKeyPem),
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['sign'],
    )
    const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(`${header}.${claims}`))
    const jwt = `${header}.${claims}.${b64url(new Uint8Array(sig))}`
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: jwt,
      }),
    })
    if (!res.ok) return null
    const { access_token } = (await res.json()) as { access_token?: string }
    return access_token ?? null
  } catch {
    return null
  }
}

export async function sendPushToTokens(
  projectId: string | undefined,
  serviceAccountJson: string | undefined,
  deviceTokens: string[],
  payload: Payload,
): Promise<void> {
  try {
    if (!projectId || !serviceAccountJson || deviceTokens.length === 0) return
    const sa = JSON.parse(serviceAccountJson) as { client_email?: string; private_key?: string }
    if (!sa.client_email || !sa.private_key) return
    const accessToken = await getAccessToken(sa.client_email, sa.private_key)
    if (!accessToken) return
    await Promise.allSettled(
      deviceTokens.map((token) =>
        fetch(`https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: {
              token,
              notification: { title: payload.title, body: payload.body },
              data: payload.data,
              webpush: { fcmOptions: { link: '/' } },
            },
          }),
        }),
      ),
    )
  } catch {
    // fire-and-forget
  }
}
