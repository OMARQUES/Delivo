import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useRecoveryStore } from '../stores/recovery'
import RecoveryResetView from './RecoveryResetView.vue'
import RecoveryStartView from './RecoveryStartView.vue'
import RecoveryVerifyView from './RecoveryVerifyView.vue'

const routeState = vi.hoisted(() => ({ query: {} as Record<string, unknown> }))
const push = vi.hoisted(() => vi.fn())
const replace = vi.hoisted(() => vi.fn())
const recoveryId = '123e4567-e89b-42d3-a456-426614174000'
const expiresAt = new Date(Date.now() + 600_000).toISOString()
const resetTicket = 'B'.repeat(43)

vi.mock('vue-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue-router')>()
  return {
    ...actual,
    useRoute: () => routeState,
    useRouter: () => ({ push, replace }),
  }
})

const RouterLinkStub = {
  name: 'RouterLink',
  props: ['to'],
  template: '<a data-testid="router-link" :data-to="to"><slot /></a>',
}

const TurnstileStub = {
  props: ['action'],
  emits: ['update:token'],
  template: '<button type="button" data-testid="turnstile" :data-action="action" @click="$emit(\'update:token\', \'recovery-proof\')">Turnstile</button>',
}

function mountView(component: object) {
  return mount(component, {
    global: { stubs: { RouterLink: RouterLinkStub, TurnstileWidget: TurnstileStub } },
  })
}

beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.clear()
  sessionStorage.clear()
  routeState.query = {}
  push.mockReset()
  replace.mockReset()
  vi.restoreAllMocks()
})

describe('password recovery views', () => {
  it('starts only after Turnstile and always presents generic copy', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => (
      new Response(JSON.stringify({ recoveryId, expiresAt }), { status: 202 })
    ))
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = mountView(RecoveryStartView)

    expect(wrapper.text()).toContain('Se existir uma conta elegível')
    expect(wrapper.find('[data-testid="turnstile"]').attributes('data-action')).toBe('password_recovery')
    expect(wrapper.find('button[type="submit"]').attributes('disabled')).toBeDefined()
    await wrapper.find('input[autocomplete="email"]').setValue('  ANA@EXAMPLE.TEST  ')
    await wrapper.find('[data-testid="turnstile"]').trigger('click')
    await wrapper.find('form').trigger('submit.prevent')
    await flushPromises()

    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]!.body))).toEqual({
      email: 'ana@example.test',
      turnstileToken: 'recovery-proof',
    })
    expect(push).toHaveBeenCalledWith({ name: 'recovery-verify', query: { id: recoveryId } })
    expect(JSON.stringify(localStorage)).not.toContain(recoveryId)
    expect(JSON.stringify(sessionStorage)).not.toContain(recoveryId)
  })

  it('accepts six digits and carries raw ticket only through Pinia memory', async () => {
    routeState.query = { id: recoveryId }
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => (
      new Response(JSON.stringify({ resetTicket, expiresAt }), { status: 200 })
    ))
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = mountView(RecoveryVerifyView)
    const code = wrapper.find('[data-testid="recovery-code"]')

    await code.setValue('12a3456x')
    expect((code.element as HTMLInputElement).value).toBe('123456')
    await wrapper.find('form').trigger('submit.prevent')
    await flushPromises()

    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]!.body))).toEqual({ recoveryId, code: '123456' })
    expect(useRecoveryStore().resetTicket).toBe(resetTicket)
    expect(push).toHaveBeenCalledWith({ name: 'recovery-reset' })
    expect(JSON.stringify(push.mock.calls)).not.toContain(resetTicket)
    expect(JSON.stringify(localStorage)).not.toContain(resetTicket)
    expect(JSON.stringify(sessionStorage)).not.toContain(resetTicket)
  })

  it('returns safely to start when reload loses the in-memory reset ticket', async () => {
    const wrapper = mountView(RecoveryResetView)
    await flushPromises()

    expect(wrapper.find('form').exists()).toBe(false)
    expect(replace).toHaveBeenCalledWith({ name: 'recovery-start', query: { reason: 'flow-lost' } })
  })

  it('uses role-neutral policy copy, resets without selectors, clears state, and links to login', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => (
      new Response(null, { status: 204 })
    ))
    vi.stubGlobal('fetch', fetchMock)
    const store = useRecoveryStore()
    store.$patch({ resetTicket, resetExpiresAt: expiresAt })
    const wrapper = mountView(RecoveryResetView)

    expect(wrapper.text()).toContain('Algumas contas exigem no mínimo 15')
    await wrapper.find('input[autocomplete="new-password"]').setValue('new secure password')
    await wrapper.find('[data-testid="password-confirmation"]').setValue('new secure password')
    await wrapper.find('form').trigger('submit.prevent')
    await flushPromises()

    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]!.body))
    expect(body).toEqual({ resetTicket, newPassword: 'new secure password' })
    expect(body).not.toHaveProperty('email')
    expect(body).not.toHaveProperty('userId')
    expect(body).not.toHaveProperty('code')
    expect(store.resetTicket).toBeNull()
    expect(wrapper.text()).toContain('Senha alterada')
    expect(wrapper.find('[data-testid="router-link"]').attributes('data-to')).toBe('/login')
  })

  it('declares recovery routes before the public store slug catch-all', async () => {
    const { router } = await import('../router')

    expect(router.resolve('/recuperar-senha').name).toBe('recovery-start')
    expect(router.resolve('/recuperar-senha/codigo').name).toBe('recovery-verify')
    expect(router.resolve('/recuperar-senha/nova-senha').name).toBe('recovery-reset')
  })
})
