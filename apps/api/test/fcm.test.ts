import { afterEach, describe, expect, it, vi } from 'vitest'
import { sendPushToTokens } from '../src/lib/fcm'

// chave de TESTE, não é segredo.
const TEST_PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQCjVmWtDzJfe2kn
SwtEXAGiiFwEjJXEND+7nuFbSbS+oZMKpybXJFREBYOaD6KF6dytdpq8HrRXOglB
waqRAjcF6GEnNKNq/Dg5qdeoeVVzGO/oSsbq5yzz8/KmFUFgGYGiUCWwDTJLJ0DT
mc4FekrXIGQlf7Q1TLgzPUEPzpdiU63qpxLNUXrQTR2bW+hIyfNqg/5i/LJdNAjv
XzZ0ep1ioGAcbv4xRa+nCDZhcGXsCmrBI4Tx/X+mfI8J9B4PzkqHyRqhoZwWVvzj
aldG6i0XJo5e0xZiLVF4dtTxsYOAuy0jifxMmwh6Q0d6MF6EN70BCilzPj4aNsSI
qx1yeMvnAgMBAAECggEADvx1VbyINaSAEF/dR8ddSwlR0AUKFLdqhY9dQ9/uWnM+
p4KQmLq3lIog+finQ7wiSDQSnGIAz+P+R286dBWM8NjSWSOGPuGnUvsXU1jWkznd
gSWjPJg7UqK2R7C5j9SnRTovSwja7XRLiV6aPXxr83MAXURrR1yjpeff2VBuKVI4
jnqKbXtvQXzB20gvbtdyzcAKgpTnuLx0bYFoZFeFQ/flk22LOgje5z9ke1qvYNqH
G3/99rv8vVjkAkcQCLPY1szy2CzW05/DtO3AGaZ6KtXl+nPis/hznzIctqU842TI
vzCpi5r8raGUpDRF3NJBpDIe37u3wXmrGNmWlYrloQKBgQDajZq9SnHxEfZ0qrfI
lKLkD438NQcvFuoLDE+TlVwnH1cv4bOeFksSQAk34pAg4SGf/h2VTGnec6HSUwQZ
XDs09wWSHXakz/n1SfhGU7jga1EQtxRrMlZUJ+EKpZUrEh7CX6E7x49nIIvpj0aK
Rnggie2sbjj+RK2dJ42JfnjylwKBgQC/Ut5mdHJCu5IURLlLo65rTr+sJxY9Vw5L
oSmyNYGXiQQRIuKZ5ZYkUM1dJjqfvusB7+Rz7+noaVKndnoS7mre9R7pwED6EKbh
2VSPl4FY4HQA2swdlylNoApR/ggDxGmTw/oXUUt61jxFyX8ByrUTWzw0DaNOrzNi
c1nNYWUrMQKBgEzxp7XW3NCTk2I1rGiIs+R4+XL+tF3GwnVLS0TZQ81eQlLQMm2I
ybtOIjCzqix5Nl5el8m1UlyH90PWCE5pY0rdYO+1Qcz6j7Tk6uzPkvonri2lVyH6
YdxVAey+qQq14XBrPJeQRZN4KOn8kEgkUSybgrq/P399bGY0w6bRiQFXAoGBAJqS
hQQZiEbJ7Bdb/qhRsZUYplqbqagdMXuA1YMZH34iQJrnqFPV3Rux/HkJbcuqH4wN
GHFin4QZs6GAYtfwr386YqNPpC9kTK+jOmJYcTQxAwe9vbMacVA5wJzFtAv3H6U2
bFNyZpzzgPaQ+H+mGe1thJI5gnsLqWQc9aysx2PBAoGAUQXlKyLftO9p9SSUT5hB
sFI3U/xDUAgrAm8gUIyD+zIwIyGbyagONdhbGgpBa2kQAaUEpkth2uWqNZAZLC97
5rHlkD8EplAHjKP5L08ez13/g/bgphUWEr5FccAUUpwSYjjfQ5B+ASeb0Oa23P+W
75ODvx8b1ncI2Szi7CLrKh4=
-----END PRIVATE KEY-----`

const SA = JSON.stringify({
  client_email: 'test@test.iam.gserviceaccount.com',
  private_key: TEST_PRIVATE_KEY,
})

afterEach(() => vi.unstubAllGlobals())

describe('sendPushToTokens', () => {
  it('skips silently when env not configured', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await sendPushToTokens(undefined, undefined, ['tok1'], { title: 'x', body: 'y', data: {} })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('gets oauth token once and sends one message per device token', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('oauth2.googleapis.com')) {
        return new Response(JSON.stringify({ access_token: 'at-123', expires_in: 3600 }), { status: 200 })
      }
      return new Response(JSON.stringify({ name: 'ok' }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    await sendPushToTokens('proj-1', SA, ['tokA', 'tokB'], { title: 'Nova entrega', body: 'Pizzaria', data: { orderId: 'o1' } })
    const urls = fetchMock.mock.calls.map((c) => String(c[0]))
    expect(urls.filter((u) => u.includes('oauth2')).length).toBe(1)
    expect(urls.filter((u) => u.includes('fcm.googleapis.com/v1/projects/proj-1/messages:send')).length).toBe(2)
  })

  it('never throws on fcm errors (fire-and-forget)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })))
    await expect(
      sendPushToTokens('proj-1', SA, ['tokA'], { title: 'x', body: 'y', data: {} }),
    ).resolves.toBeUndefined()
  })
})
