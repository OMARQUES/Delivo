import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import LoginView from './LoginView.vue'

const replace = vi.fn()

vi.mock('vue-router', () => ({
  useRouter: () => ({ replace }),
  RouterLink: { template: '<a><slot /></a>' },
}))

const tokens = { accessToken: 'acc-1', refreshToken: 'ref-1' }
const customer = { id: 'u1', name: 'Ana', role: 'CUSTOMER', status: 'ACTIVE', phone: '44', email: 'ana@email.com' }

beforeEach(() => {
  vi.unstubAllEnvs()
  setActivePinia(createPinia())
  localStorage.clear()
  vi.restoreAllMocks()
  replace.mockReset()
})

describe('driver LoginView', () => {
  it('resubmits Turnstile challenge, rejects non-driver session, and clears storage', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ error: 'Confirme que você não é um robô', code: 'TURNSTILE_REQUIRED' }),
        { status: 401 },
      ))
      .mockResolvedValueOnce(new Response(JSON.stringify({ user: customer, ...tokens }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const wrapper = mount(LoginView, {
      global: {
        stubs: {
          RouterLink: { template: '<a><slot /></a>' },
          TurnstileWidget: {
            emits: ['update:token'],
            template: '<button type="button" data-testid="turnstile" @click="$emit(\'update:token\', \'tok-1\')">Turnstile</button>',
          },
        },
      },
    })

    await wrapper.find('input[autocomplete="email"]').setValue('ana@email.com')
    await wrapper.find('input[autocomplete="current-password"]').setValue('senha123')
    await wrapper.find('form').trigger('submit.prevent')
    await flushPromises()
    expect(wrapper.find('[data-testid="turnstile"]').exists()).toBe(true)

    await wrapper.find('[data-testid="turnstile"]').trigger('click')
    await wrapper.find('form').trigger('submit.prevent')
    await flushPromises()

    expect(JSON.parse(String(fetchMock.mock.calls[1]![1]!.body))).toMatchObject({
      email: 'ana@email.com',
      password: 'senha123',
      turnstileToken: 'tok-1',
    })
    expect(JSON.parse(String(fetchMock.mock.calls[1]![1]!.body))).not.toHaveProperty('identifier')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(wrapper.text()).toContain('Esta conta não é de entregador')
    expect(localStorage.getItem('delivery.driver.auth')).toBeNull()
    expect(replace).not.toHaveBeenCalled()
  })

  it('links password recovery to the configured public web app only', () => {
    vi.stubEnv('VITE_PUBLIC_WEB_URL', 'https://public-app.example.test/base')

    const wrapper = mount(LoginView, {
      global: { stubs: { RouterLink: { template: '<a><slot /></a>' }, TurnstileWidget: true } },
    })

    const recovery = wrapper.find('[data-testid="recovery-link"]')
    expect(recovery.attributes('href')).toBe('https://public-app.example.test/recuperar-senha')
    expect(recovery.attributes('href')).not.toContain('8787')
  })
})
