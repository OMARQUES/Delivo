import type { EmailEnvelope, EmailTemplate } from './types'

type RenderEmailInput = {
  to: string
  template: EmailTemplate
  code?: string
  publicWebUrl: string
  flowId?: string
}

const CODE_TEMPLATES = new Set<EmailTemplate>(['VERIFICATION_CODE', 'PASSWORD_RECOVERY'])

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function buildPublicUrl(publicWebUrl: string, flowId?: string): string {
  let url: URL
  try {
    url = new URL(publicWebUrl)
  } catch {
    throw new Error('Invalid public web url')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('Invalid public web url')
  if (flowId) url.searchParams.set('flowId', flowId)
  return url.href
}

function assertCode(template: EmailTemplate, code?: string) {
  if (!CODE_TEMPLATES.has(template)) {
    if (code !== undefined) throw new Error('Template does not accept code')
    return
  }
  if (!code || !/^\d{6}$/.test(code)) throw new Error('Template requires a six digit code')
}

function codeBlock(code: string): string {
  return `<div style="margin:24px 0;text-align:center;font-size:40px;font-weight:700;letter-spacing:10px;line-height:1.2">${escapeHtml(code)}</div>`
}

function codeCopy(template: EmailTemplate) {
  if (template === 'PASSWORD_RECOVERY') {
    return {
      subject: 'Codigo para recuperar sua senha',
      title: 'Recupere sua senha',
      intro: 'Use o codigo abaixo para continuar a recuperacao da sua senha.',
    }
  }
  return {
    subject: 'Codigo de verificacao',
    title: 'Confirme seu email',
    intro: 'Use o codigo abaixo para confirmar seu email.',
  }
}

function noticeCopy(template: EmailTemplate) {
  if (template === 'PASSWORD_CHANGED_NOTICE') {
    return {
      subject: 'Sua senha foi alterada',
      title: 'Senha alterada',
      intro: 'A senha da sua conta foi alterada com sucesso.',
    }
  }
  return {
    subject: 'Ja existe uma conta com este email',
    title: 'Conta ja existente',
    intro: 'Recebemos uma tentativa de cadastro para este email, mas ele ja esta associado a uma conta.',
  }
}

function htmlShell(title: string, body: string): string {
  return [
    '<!doctype html>',
    '<html>',
    '<body style="margin:0;padding:0;background:#f6f7f9;color:#111827;font-family:Arial,sans-serif">',
    '<main style="max-width:560px;margin:0 auto;padding:32px 20px">',
    '<section style="background:#ffffff;border:1px solid #e5e7eb;border-radius:8px;padding:28px">',
    `<h1 style="margin:0 0 16px;font-size:22px;line-height:1.3">${escapeHtml(title)}</h1>`,
    body,
    '</section>',
    '</main>',
    '</body>',
    '</html>',
  ].join('')
}

export function renderEmail(input: RenderEmailInput): EmailEnvelope {
  assertCode(input.template, input.code)
  const publicUrl = buildPublicUrl(input.publicWebUrl, CODE_TEMPLATES.has(input.template) ? input.flowId : undefined)

  if (CODE_TEMPLATES.has(input.template)) {
    const code = input.code!
    const copy = codeCopy(input.template)
    const escapedTo = escapeHtml(input.to)
    const escapedUrl = escapeHtml(publicUrl)
    const html = htmlShell(copy.title, [
      `<p style="margin:0 0 16px;font-size:16px;line-height:1.5">Ola, ${escapedTo}.</p>`,
      `<p style="margin:0 0 16px;font-size:16px;line-height:1.5">${escapeHtml(copy.intro)}</p>`,
      codeBlock(code),
      '<p style="margin:0 0 16px;font-size:14px;line-height:1.5">Este codigo expira em 10 minutos. Nao compartilhe este codigo com ninguem.</p>',
      `<p style="margin:0;font-size:14px;line-height:1.5"><a href="${escapedUrl}" style="color:#2563eb;text-decoration:underline">Abrir no app</a></p>`,
    ].join(''))
    const text = [
      copy.title,
      '',
      `Ola, ${input.to}.`,
      copy.intro,
      '',
      code,
      '',
      'Este codigo expira em 10 minutos. Nao compartilhe este codigo com ninguem.',
      publicUrl,
    ].join('\n')
    return { to: input.to, subject: copy.subject, html, text }
  }

  const copy = noticeCopy(input.template)
  const html = htmlShell(copy.title, [
    `<p style="margin:0 0 16px;font-size:16px;line-height:1.5">Ola, ${escapeHtml(input.to)}.</p>`,
    `<p style="margin:0 0 16px;font-size:16px;line-height:1.5">${escapeHtml(copy.intro)}</p>`,
    '<p style="margin:0;font-size:14px;line-height:1.5">Se voce nao solicitou isso, nenhuma acao e necessaria.</p>',
  ].join(''))
  const text = [
    copy.title,
    '',
    `Ola, ${input.to}.`,
    copy.intro,
    '',
    'Se voce nao solicitou isso, nenhuma acao e necessaria.',
  ].join('\n')
  return { to: input.to, subject: copy.subject, html, text }
}

export type { EmailEnvelope, EmailTemplate }
