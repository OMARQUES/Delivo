import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import AdminStoresView from './AdminStoresView.vue'

const pendingStore = {
  id: '123e4567-e89b-42d3-a456-426614174000',
  name: 'Loja Pendente',
  slug: 'loja-pendente',
  category: 'OUTROS',
  commissionBps: 0,
  securityStatus: 'PENDING_ACTIVATION',
}

function response(body: unknown, status = 200) {
  return new Response(status === 204 ? null : JSON.stringify(body), { status })
}

function mountView() {
  return mount(AdminStoresView, {
    global: {
      stubs: {
        TurnstileWidget: {
          props: ['action'],
          emits: ['update:token'],
          template: '<button data-testid="turnstile" :data-action="action" @click="$emit(\'update:token\', \'proof\')">Turnstile</button>',
        },
      },
    },
  })
}

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('AdminStoresView', () => {
  it('provisions owner by email without password field or password payload', async () => {
    const resendAt = new Date(Date.now() + 60_000).toISOString()
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response([]))
      .mockResolvedValueOnce(response({
        store: pendingStore,
        owner: {
          id: '223e4567-e89b-42d3-a456-426614174000',
          name: 'Dona',
          email: 'dona@example.test',
          phone: null,
          role: 'STORE',
          status: 'PENDING_EMAIL',
        },
        verification: { expiresAt: new Date(Date.now() + 600_000).toISOString(), resendAt },
      }, 201))
      .mockResolvedValueOnce(response([pendingStore]))
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = mountView()
    await flushPromises()

    await wrapper.get('button').trigger('click')
    expect(wrapper.find('input[type="password"]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('Senha inicial')
    await wrapper.get('input[placeholder="Nome da loja"]').setValue('Loja Pendente')
    await wrapper.get('input[placeholder="slug-da-loja"]').setValue('loja-pendente')
    await wrapper.get('input[placeholder="WhatsApp da loja"]').setValue('44999990000')
    await wrapper.get('input[placeholder="Cidade"]').setValue('Maringá')
    await wrapper.get('input[placeholder="Endereço"]').setValue('Rua A, 1')
    await wrapper.get('input[placeholder="Nome do dono"]').setValue('Dona')
    await wrapper.get('input[placeholder="Email de login"]').setValue('dona@example.test')
    await wrapper.get('form').trigger('submit.prevent')
    await flushPromises()

    const post = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST')
    expect(post).toBeTruthy()
    const body = JSON.parse(String(post![1]!.body))
    expect(body.owner).toEqual({ name: 'Dona', email: 'dona@example.test' })
    expect(JSON.stringify(body)).not.toContain('password')
    expect(wrapper.text()).toContain('Aguardando ativação')
    expect(wrapper.get('[data-testid="activation-resend"]').text()).toContain('Reenviar em')
  })

  it('shows pending state, disables operational controls, then starts resend countdown', async () => {
    const resendAt = new Date(Date.now() + 60_000).toISOString()
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response([pendingStore]))
      .mockResolvedValueOnce(response({
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
        resendAt,
      }, 202))
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = mountView()
    await flushPromises()

    expect(wrapper.text()).toContain('Aguardando ativação')
    expect(wrapper.get('[data-testid="commission"]').attributes('disabled')).toBeDefined()
    expect(wrapper.find('[data-testid="security-status-action"]').exists()).toBe(false)
    const resend = wrapper.get('[data-testid="activation-resend"]')
    expect(resend.attributes('disabled')).toBeUndefined()
    await resend.trigger('click')
    await flushPromises()

    const post = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST')
    expect(String(post?.[0])).toContain(`/admin/stores/${pendingStore.id}/activation/resend`)
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({})
    expect(resend.attributes('disabled')).toBeDefined()
    expect(resend.text()).toContain('Reenviar em')
  })
})
