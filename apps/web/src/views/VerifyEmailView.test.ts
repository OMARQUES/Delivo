import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import VerifyEmailView from './VerifyEmailView.vue'

const routeState = vi.hoisted(() => ({ query: { id: '' } }))
const replace = vi.hoisted(() => vi.fn())
const verificationId = '123e4567-e89b-42d3-a456-426614174000'

vi.mock('vue-router', () => ({
  useRoute: () => routeState,
  useRouter: () => ({ replace }),
}))

const user = {
  id: 'customer-1', name: 'Ana', role: 'CUSTOMER', status: 'ACTIVE',
  phone: null, email: 'ana@example.test',
}

function flow(offsetMs = 600_000) {
  return {
    verificationId,
    expiresAt: new Date(Date.now() + offsetMs).toISOString(),
    resendAt: new Date(Date.now() - 1_000).toISOString(),
  }
}

function mountView() {
  return mount(VerifyEmailView, {
    global: {
      stubs: {
        RouterLink: { template: '<a><slot /></a>' },
        TurnstileWidget: {
          props: ['action'],
          emits: ['update:token'],
          template: '<button type="button" data-testid="turnstile" :data-action="action" @click="$emit(\'update:token\', \'resend-token\')">Turnstile</button>',
        },
      },
    },
  })
}

beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.clear()
  sessionStorage.clear()
  routeState.query.id = verificationId
  replace.mockReset()
  vi.restoreAllMocks()
})

describe('VerifyEmailView', () => {
  it('accepts only six digits, clears failed code, then persists CUSTOMER session', async () => {
    sessionStorage.setItem(`delivery.auth.verification.${verificationId}`, JSON.stringify(flow()))
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ error: 'Código inválido ou expirado.', code: 'CODE_INVALID_OR_EXPIRED' }),
        { status: 400 },
      ))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        kind: 'CUSTOMER_SESSION', user, accessToken: 'access', refreshToken: 'refresh',
      }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = mountView()
    const code = wrapper.find('[data-testid="verification-code"]')
    expect(code.attributes('inputmode')).toBe('numeric')
    expect(code.attributes('maxlength')).toBe('6')

    await code.setValue('123456')
    await wrapper.find('form').trigger('submit.prevent')
    await flushPromises()
    expect((code.element as HTMLInputElement).value).toBe('')
    expect(wrapper.text()).toContain('Código inválido ou expirado')

    await code.setValue('654321')
    await wrapper.find('form').trigger('submit.prevent')
    await flushPromises()
    expect(localStorage.getItem('delivery.auth')).toContain('access')
    expect(sessionStorage.getItem(`delivery.auth.verification.${verificationId}`)).toBeNull()
    expect(replace).toHaveBeenCalledWith('/')
    expect(localStorage.getItem('delivery.auth')).not.toContain('654321')
  })

  it('handles adaptive Turnstile resend and stores only public timing', async () => {
    sessionStorage.setItem(`delivery.auth.verification.${verificationId}`, JSON.stringify(flow()))
    const replacement = flow(1_200_000)
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ error: 'Verificação de segurança necessária.', code: 'TURNSTILE_REQUIRED' }),
        { status: 403 },
      ))
      .mockResolvedValueOnce(new Response(JSON.stringify(replacement), { status: 202 }))
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = mountView()

    await wrapper.find('[data-testid="resend"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="turnstile"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="turnstile"]').attributes('data-action')).toBe('email_resend')
    await wrapper.find('[data-testid="turnstile"]').trigger('click')
    await wrapper.find('[data-testid="resend"]').trigger('click')
    await flushPromises()

    const body = JSON.parse(String(fetchMock.mock.calls[1]![1]!.body))
    expect(body).toEqual({ verificationId, turnstileToken: 'resend-token' })
    const stored = sessionStorage.getItem(`delivery.auth.verification.${verificationId}`)!
    expect(stored).toContain(replacement.expiresAt)
    expect(stored).not.toContain('resend-token')
  })

  it('honors Retry-After without losing deep-link flow ID', async () => {
    sessionStorage.setItem(`delivery.auth.verification.${verificationId}`, JSON.stringify(flow()))
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ error: 'Muitas tentativas.', code: 'RATE_LIMITED' }),
      { status: 429, headers: { 'Retry-After': '30' } },
    )))
    const wrapper = mountView()

    await wrapper.find('[data-testid="resend"]').trigger('click')
    await flushPromises()

    expect(wrapper.find('[data-testid="resend"]').attributes('disabled')).toBeDefined()
    expect(wrapper.text()).toContain('Reenviar em')
    expect(routeState.query.id).toBe(verificationId)
  })

  it('navigates STORE to password setup without putting ticket in URL or storage', async () => {
    const ticket = 'S'.repeat(43)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      kind: 'PASSWORD_SETUP_REQUIRED',
      passwordSetupTicket: ticket,
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    }), { status: 200 })))
    const wrapper = mountView()

    await wrapper.get('[data-testid="verification-code"]').setValue('123456')
    await wrapper.get('form').trigger('submit.prevent')
    await flushPromises()

    expect(replace).toHaveBeenCalledWith({ name: 'initial-password-setup' })
    expect(JSON.stringify(replace.mock.calls)).not.toContain(ticket)
    expect(JSON.stringify(localStorage)).not.toContain(ticket)
    expect(JSON.stringify(sessionStorage)).not.toContain(ticket)
    expect(wrapper.find('[data-testid="resend"]').exists()).toBe(false)
  })

  it('shows ADMIN confirmation guidance without creating a session', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ kind: 'EMAIL_VERIFIED' }),
      { status: 200 },
    )))
    const wrapper = mountView()

    await wrapper.get('[data-testid="verification-code"]').setValue('123456')
    await wrapper.get('form').trigger('submit.prevent')
    await flushPromises()

    expect(wrapper.text()).toContain('Email confirmado')
    expect(wrapper.text()).toContain('login')
    expect(localStorage.getItem('delivery.auth')).toBeNull()
    expect(replace).not.toHaveBeenCalled()
  })
})
