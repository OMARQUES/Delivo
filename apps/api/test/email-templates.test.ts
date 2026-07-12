import { describe, expect, it } from 'vitest'
import { renderEmail } from '../src/email/templates'

describe('auth email templates', () => {
  it.each(['VERIFICATION_CODE', 'PASSWORD_RECOVERY'] as const)(
    'renders %s with a large selectable code and safety guidance',
    (template) => {
      const email = renderEmail({
        to: 'user@example.com',
        template,
        code: '012345',
        publicWebUrl: 'https://app.example.com/auth?next=<bad>',
        flowId: 'flow<&>"',
      })

      expect(email.to).toBe('user@example.com')
      expect(email.subject).not.toContain('012345')
      expect(email.html).toContain('012345')
      expect(email.text).toContain('012345')
      expect(email.html).toMatch(/font-size:\s*(3[2-9]|[4-9]\d)px/i)
      expect(email.html).toMatch(/text-align:\s*center/i)
      expect(email.html).toMatch(/letter-spacing:\s*\d+px/i)
      expect(email.html).toMatch(/10 minutos/i)
      expect(email.text).toMatch(/10 minutos/i)
      expect(email.html).toMatch(/nao compartilhe/i)
      expect(email.text).toMatch(/nao compartilhe/i)
      expect(email.html).not.toContain('<bad>')
      expect(email.html).not.toContain('flow<&>"')
      expect(email.html).toContain('flow%3C%26%3E%22')
      expect(email.html).not.toMatch(/<img\b/i)
      expect(email.html).not.toMatch(/data:/i)
      expect(email.text).not.toMatch(/data:/i)
    },
  )

  it('escapes html in URLs and attributes', () => {
    const email = renderEmail({
      to: 'evil"@example.com',
      template: 'VERIFICATION_CODE',
      code: '123456',
      publicWebUrl: 'https://app.example.com/verify?x="><script>alert(1)</script>',
      flowId: '"><svg onload=alert(1)>',
    })

    expect(email.html).not.toContain('<script>')
    expect(email.html).not.toContain('<svg')
    expect(email.html).not.toContain('evil"@example.com')
    expect(email.html).toContain('evil&quot;@example.com')
    expect(email.html).toContain('%22%3E%3Cscript%3Ealert%281%29%3C%2Fscript%3E')
  })

  it('rejects invalid public web urls', () => {
    expect(() => renderEmail({
      to: 'user@example.com',
      template: 'VERIFICATION_CODE',
      code: '123456',
      publicWebUrl: 'javascript:alert(1)',
    })).toThrow(/public web url/i)
  })

  it.each(['VERIFICATION_CODE', 'PASSWORD_RECOVERY'] as const)(
    'requires a six digit code for %s',
    (template) => {
      expect(() => renderEmail({
        to: 'user@example.com',
        template,
        publicWebUrl: 'https://app.example.com',
      })).toThrow(/code/i)
      expect(() => renderEmail({
        to: 'user@example.com',
        template,
        code: '12345a',
        publicWebUrl: 'https://app.example.com',
      })).toThrow(/code/i)
    },
  )

  it.each(['ACCOUNT_EXISTS_NOTICE', 'PASSWORD_CHANGED_NOTICE'] as const)(
    'renders %s without codes or flow ids',
    (template) => {
      expect(() => renderEmail({
        to: 'user@example.com',
        template,
        code: '123456',
        publicWebUrl: 'https://app.example.com',
      })).toThrow(/code/i)

      const email = renderEmail({
        to: 'user@example.com',
        template,
        publicWebUrl: 'https://app.example.com',
        flowId: 'must-not-leak',
      })

      expect(email.html).not.toContain('must-not-leak')
      expect(email.text).not.toContain('must-not-leak')
      expect(email.html).not.toContain('123456')
      expect(email.text).not.toContain('123456')
    },
  )
})
