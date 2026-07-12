import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import VerifyEmailView from './VerifyEmailView.vue'

const routeState = vi.hoisted(() => ({ query: { id: '' } }))
const verificationId = '123e4567-e89b-42d3-a456-426614174000'
vi.mock('vue-router', () => ({ useRoute: () => routeState }))

function flow() {
  return {
    verificationId,
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
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
  vi.restoreAllMocks()
})

describe('driver VerifyEmailView', () => {
  it('clears failed code then shows pending approval without session', async () => {
    sessionStorage.setItem(`delivery.driver.auth.verification.${verificationId}`, JSON.stringify(flow()))
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ error: 'Código inválido ou expirado.', code: 'CODE_INVALID_OR_EXPIRED' }),
        { status: 400 },
      ))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        kind: 'DRIVER_PENDING_APPROVAL',
        user: { id: 'driver-1', name: 'Dan', role: 'DRIVER', status: 'PENDING_APPROVAL', phone: '44999998888', email: 'dan@example.test' },
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

    await code.setValue('654321')
    await wrapper.find('form').trigger('submit.prevent')
    await flushPromises()
    expect(wrapper.text()).toContain('aguardando aprovação')
    expect(localStorage.getItem('delivery.driver.auth')).toBeNull()
    expect(sessionStorage.getItem(`delivery.driver.auth.verification.${verificationId}`)).toBeNull()
  })

  it('handles adaptive Turnstile resend with backend action', async () => {
    sessionStorage.setItem(`delivery.driver.auth.verification.${verificationId}`, JSON.stringify(flow()))
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ error: 'Verificação de segurança necessária.', code: 'TURNSTILE_REQUIRED' }),
        { status: 403 },
      ))
      .mockResolvedValueOnce(new Response(JSON.stringify(flow()), { status: 202 }))
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = mountView()

    await wrapper.find('[data-testid="resend"]').trigger('click')
    await flushPromises()
    const turnstile = wrapper.find('[data-testid="turnstile"]')
    expect(turnstile.attributes('data-action')).toBe('email_resend')
    await turnstile.trigger('click')
    await wrapper.find('[data-testid="resend"]').trigger('click')
    await flushPromises()

    expect(JSON.parse(String(fetchMock.mock.calls[1]![1]!.body)))
      .toEqual({ verificationId, turnstileToken: 'resend-token' })
    expect(localStorage.getItem('delivery.driver.auth')).toBeNull()
  })
})
