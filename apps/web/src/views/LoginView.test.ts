import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import LoginView from './LoginView.vue'

const replace = vi.fn()

vi.mock('vue-router', () => ({
  useRouter: () => ({ replace }),
  useRoute: () => ({ query: {} }),
}))

const tokens = { accessToken: 'acc-1', refreshToken: 'ref-1' }
const user = { id: 'u1', name: 'Ana', role: 'CUSTOMER', status: 'ACTIVE', phone: '44', email: 'ana@email.com' }

beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.clear()
  vi.restoreAllMocks()
  replace.mockReset()
})

describe('LoginView', () => {
  it('reveals Turnstile after TURNSTILE_REQUIRED and resubmits with same identifier plus token', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ error: 'Confirme que você não é um robô', code: 'TURNSTILE_REQUIRED' }),
        { status: 401 },
      ))
      .mockResolvedValueOnce(new Response(JSON.stringify({ user, ...tokens }), { status: 200 }))
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

    await wrapper.find('input[autocomplete="username"]').setValue('ana@email.com')
    await wrapper.find('input[autocomplete="current-password"]').setValue('senha123')
    await wrapper.find('form').trigger('submit.prevent')
    await flushPromises()

    expect(wrapper.text()).toContain('Confirme que você não é um robô')
    expect(wrapper.find('[data-testid="turnstile"]').exists()).toBe(true)

    await wrapper.find('[data-testid="turnstile"]').trigger('click')
    await wrapper.find('form').trigger('submit.prevent')
    await flushPromises()

    expect(JSON.parse(String(fetchMock.mock.calls[1]![1]!.body))).toMatchObject({
      identifier: 'ana@email.com',
      password: 'senha123',
      turnstileToken: 'tok-1',
    })
    expect(replace).toHaveBeenCalledWith('/')
  })
})
