import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAuthStore } from '../stores/auth'
import { useCartStore } from '../stores/cart'
import CheckoutView from './CheckoutView.vue'

const replace = vi.fn()

vi.mock('vue-router', () => ({ useRouter: () => ({ replace }) }))
vi.mock('../lib/mp-brick', () => ({
  cardConfigured: () => false,
  mountCardBrick: vi.fn(),
}))

const customer = {
  id: 'customer-1',
  name: 'Ana',
  role: 'CUSTOMER' as const,
  status: 'ACTIVE' as const,
  phone: null,
  email: 'ana@example.test',
}

function button(wrapper: VueWrapper, label: string) {
  const match = wrapper.findAll('button').find((item) => item.text() === label)
  if (!match) throw new Error(`button not found: ${label}`)
  return match
}

function apiMock(contactStatus = 200) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname
    const method = init?.method ?? 'GET'
    if (path === '/me/addresses') {
      return new Response(JSON.stringify([{
        id: 'address-1', label: 'Casa', addressText: 'Rua A, 1', reference: null, lat: -23.5, lng: -51.9,
      }]), { status: 200 })
    }
    if (path === '/orders/quote') {
      return new Response(JSON.stringify({ subtotalCents: 1000, deliveryFeeCents: 500, totalCents: 1500, problems: [] }), { status: 200 })
    }
    if (path === '/auth/me/contact' && method === 'PATCH') {
      if (contactStatus !== 200) {
        return new Response(JSON.stringify({ error: 'Serviço indisponível' }), { status: contactStatus })
      }
      return new Response(JSON.stringify({ phone: '44999998888' }), { status: 200 })
    }
    if (path === '/orders' && method === 'POST') {
      return new Response(JSON.stringify({ order: { id: 'order-1' }, payment: null }), { status: 200 })
    }
    throw new Error(`unexpected request: ${method} ${path}`)
  })
}

async function mountCheckout(fetchMock: ReturnType<typeof apiMock>) {
  vi.stubGlobal('fetch', fetchMock)
  const auth = useAuthStore()
  auth.setSession({ user: { ...customer }, accessToken: 'access', refreshToken: 'refresh' })
  const cart = useCartStore()
  cart.$patch({
    storeSlug: 'store-1',
    storeName: 'Store',
    items: [{
      uid: 'item-1', productId: 'product-1', name: 'Item', quantity: 1,
      unitPriceCents: 1000, selections: [], optionLabels: [],
    }],
  })
  const wrapper = mount(CheckoutView, {
    global: { stubs: { MapPicker: { template: '<div />' } } },
  })
  await flushPromises()
  return { wrapper, auth }
}

beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.clear()
  replace.mockReset()
  vi.restoreAllMocks()
})

describe('CheckoutView optional contact prompt', () => {
  it('offers contact phone once and Agora não continues order immediately', async () => {
    const fetchMock = apiMock()
    const { wrapper } = await mountCheckout(fetchMock)

    await button(wrapper, 'Confirmar pedido').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="contact-prompt"]').exists()).toBe(true)
    expect(fetchMock.mock.calls.some(([input, init]) => new URL(String(input)).pathname === '/orders' && init?.method === 'POST')).toBe(false)

    await button(wrapper, 'Agora não').trigger('click')
    await flushPromises()
    expect(replace).toHaveBeenCalledWith('/pedido/order-1')
  })

  it('saves contact into Pinia and persistence before continuing', async () => {
    const fetchMock = apiMock()
    const { wrapper, auth } = await mountCheckout(fetchMock)
    await button(wrapper, 'Confirmar pedido').trigger('click')
    await wrapper.find('[data-testid="contact-phone"]').setValue('(44) 99999-8888')

    await button(wrapper, 'Salvar telefone e continuar').trigger('click')
    await flushPromises()

    expect(auth.user?.phone).toBe('44999998888')
    expect(JSON.parse(localStorage.getItem('delivery.auth')!).user.phone).toBe('44999998888')
    const contactCall = fetchMock.mock.calls.find(([input]) => new URL(String(input)).pathname === '/auth/me/contact')
    expect(JSON.parse(String(contactCall?.[1]?.body))).toEqual({ phone: '(44) 99999-8888' })
    expect(replace).toHaveBeenCalledWith('/pedido/order-1')
  })

  it('never blocks checkout after contact API failure', async () => {
    const fetchMock = apiMock(503)
    const { wrapper, auth } = await mountCheckout(fetchMock)
    await button(wrapper, 'Confirmar pedido').trigger('click')
    await wrapper.find('[data-testid="contact-phone"]').setValue('(44) 99999-8888')

    await button(wrapper, 'Salvar telefone e continuar').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('Serviço indisponível')
    expect(replace).not.toHaveBeenCalled()
    expect(auth.user?.phone).toBeNull()
    expect(JSON.parse(localStorage.getItem('delivery.auth')!).user.phone).toBeNull()

    await button(wrapper, 'Continuar sem telefone').trigger('click')
    await flushPromises()
    expect(replace).toHaveBeenCalledWith('/pedido/order-1')
  })

  it('does not bypass checkout validity while contact prompt is open', async () => {
    const fetchMock = apiMock()
    const { wrapper } = await mountCheckout(fetchMock)
    await button(wrapper, 'Confirmar pedido').trigger('click')
    ;(wrapper.vm as unknown as { addressId: string }).addressId = ''
    await flushPromises()

    await button(wrapper, 'Agora não').trigger('click')
    await flushPromises()

    expect(fetchMock.mock.calls.some(([input, init]) => new URL(String(input)).pathname === '/orders' && init?.method === 'POST')).toBe(false)
    expect(replace).not.toHaveBeenCalled()
  })

  it('does not bypass card details while contact prompt is open', async () => {
    const fetchMock = apiMock()
    const { wrapper } = await mountCheckout(fetchMock)
    await button(wrapper, 'Confirmar pedido').trigger('click')
    ;(wrapper.vm as unknown as { paymentMethod: string }).paymentMethod = 'CARD_ONLINE'
    await flushPromises()

    await button(wrapper, 'Agora não').trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('Preencha os dados do cartão')
    expect(fetchMock.mock.calls.some(([input, init]) => new URL(String(input)).pathname === '/orders' && init?.method === 'POST')).toBe(false)
    expect(replace).not.toHaveBeenCalled()
  })
})
