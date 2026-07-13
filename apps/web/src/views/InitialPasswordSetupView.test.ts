import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAuthStore } from '../stores/auth'
import InitialPasswordSetupView from './InitialPasswordSetupView.vue'

const replace = vi.hoisted(() => vi.fn())
const ticket = 'S'.repeat(43)
const expiresAt = new Date(Date.now() + 600_000).toISOString()

vi.mock('vue-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue-router')>()
  return { ...actual, useRouter: () => ({ replace }) }
})

const RouterLinkStub = {
  props: ['to'],
  template: '<a data-testid="router-link" :data-to="to"><slot /></a>',
}

function mountView() {
  return mount(InitialPasswordSetupView, { global: { stubs: { RouterLink: RouterLinkStub } } })
}

beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.clear()
  sessionStorage.clear()
  replace.mockReset()
  vi.restoreAllMocks()
})

describe('InitialPasswordSetupView', () => {
  it('returns to activation guidance when reload loses memory-only ticket', async () => {
    const wrapper = mountView()
    await flushPromises()

    expect(wrapper.find('form').exists()).toBe(false)
    expect(replace).toHaveBeenCalledWith({
      name: 'verify-email',
      query: { reason: 'password-setup-lost' },
    })
  })

  it('requires 15 matching chars, clears ticket, and links to login after success', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)
    const store = useAuthStore()
    store.$patch({ passwordSetupTicket: ticket, passwordSetupExpiresAt: expiresAt })
    const wrapper = mountView()
    const password = wrapper.get('input[autocomplete="new-password"]')
    const confirmation = wrapper.get('[data-testid="password-confirmation"]')

    expect(password.attributes('minlength')).toBe('15')
    await password.setValue('12345678901234')
    await confirmation.setValue('12345678901234')
    expect(wrapper.get('button[type="submit"]').attributes('disabled')).toBeDefined()

    await password.setValue('a strong store password')
    await confirmation.setValue('a strong store password')
    await wrapper.get('form').trigger('submit.prevent')
    await flushPromises()

    expect(store.passwordSetupTicket).toBeNull()
    expect(wrapper.text()).toContain('Conta ativada')
    expect(wrapper.get('[data-testid="router-link"]').attributes('data-to')).toBe('/login')
    expect(JSON.stringify(localStorage)).not.toContain(ticket)
    expect(JSON.stringify(sessionStorage)).not.toContain(ticket)
  })

  it('declares setup route before store slug catch-all', async () => {
    const { router } = await import('../router')
    expect(router.resolve('/ativar-conta/senha').name).toBe('initial-password-setup')
  })
})
