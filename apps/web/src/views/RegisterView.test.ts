import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import RegisterView from './RegisterView.vue'

const replace = vi.fn()
const verificationId = '123e4567-e89b-42d3-a456-426614174000'

vi.mock('vue-router', () => ({ useRouter: () => ({ replace }) }))

beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.clear()
  sessionStorage.clear()
  replace.mockReset()
  vi.restoreAllMocks()
})

describe('RegisterView', () => {
  it('requires email, keeps phone optional, forces CUSTOMER, and navigates with public flow ID only', async () => {
    const flow = {
      verificationId,
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      resendAt: new Date(Date.now() + 60_000).toISOString(),
    }
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
      async () => new Response(JSON.stringify(flow), { status: 202 }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = mount(RegisterView, {
      global: {
        stubs: {
          RouterLink: { template: '<a><slot /></a>' },
          TurnstileWidget: {
            emits: ['update:token'],
            template: '<button type="button" data-testid="turnstile" @click="$emit(\'update:token\', \'register-token\')">Turnstile</button>',
          },
        },
      },
    })

    const email = wrapper.find('input[autocomplete="email"]')
    const phone = wrapper.find('input[autocomplete="tel"]')
    expect(email.attributes('required')).toBeDefined()
    expect(phone.attributes('required')).toBeUndefined()
    await wrapper.find('input[autocomplete="name"]').setValue('Ana')
    await email.setValue('ana@example.test')
    await wrapper.find('input[autocomplete="new-password"]').setValue('safe-pass-123')
    await wrapper.find('input[type="checkbox"]').setValue(true)
    await wrapper.find('[data-testid="turnstile"]').trigger('click')
    await wrapper.find('form').trigger('submit.prevent')
    await flushPromises()

    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]!.body))
    expect(body).toMatchObject({ email: 'ana@example.test', role: 'CUSTOMER' })
    expect(body).not.toHaveProperty('phone')
    expect(replace).toHaveBeenCalledWith({ name: 'verify-email', query: { id: verificationId } })
    const navigation = JSON.stringify(replace.mock.calls)
    expect(navigation).not.toContain('safe-pass-123')
    expect(navigation).not.toContain('123456')
    expect(localStorage.getItem('delivery.auth')).toBeNull()
  })
})
