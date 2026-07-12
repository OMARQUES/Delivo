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

describe('driver RegisterView', () => {
  it('requires email, phone, 15-char password and navigates with public flow ID only', async () => {
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
    const password = wrapper.find('input[autocomplete="new-password"]')
    expect(email.attributes('required')).toBeDefined()
    expect(phone.attributes('required')).toBeDefined()
    expect(password.attributes('minlength')).toBe('15')
    await wrapper.find('input[autocomplete="name"]').setValue('Dan')
    await phone.setValue('(44) 99999-8888')
    await email.setValue('dan@example.test')
    await password.setValue('safe-driver-password')
    await wrapper.find('input[type="checkbox"]').setValue(true)
    await wrapper.find('[data-testid="turnstile"]').trigger('click')
    await wrapper.find('form').trigger('submit.prevent')
    await flushPromises()

    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]!.body))
    expect(body).toMatchObject({ role: 'DRIVER', phone: '(44) 99999-8888', email: 'dan@example.test' })
    expect(replace).toHaveBeenCalledWith({ name: 'verify-email', query: { id: verificationId } })
    expect(JSON.stringify(replace.mock.calls)).not.toContain('safe-driver-password')
    expect(localStorage.getItem('delivery.driver.auth')).toBeNull()
  })
})
