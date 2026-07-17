import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import OrderTrackingView from './OrderTrackingView.vue'

const mocks = vi.hoisted(() => ({ api: vi.fn() }))
vi.mock('../lib/api', () => ({ api: mocks.api }))
vi.mock('vue-router', () => ({ useRoute: () => ({ params: { orderId: 'order-1' } }) }))

const baseOrder = {
  id: 'order-1', status: 'AWAITING_PAYMENT', fulfillment: 'PICKUP', paymentMethod: 'CARD_ONLINE',
  subtotalCents: 1000, deliveryFeeCents: null, totalCents: 1000, addressText: null,
  cancelReason: null, cancelRequestedAt: null, createdAt: '2026-07-16T12:00:00.000Z',
  items: [], storeName: 'Pizzaria', storePhone: null, storeSlug: 'pizzaria', driverName: null,
  payment: { qrCode: null, qrCodeBase64: null, expiresAt: '2026-07-16T12:30:00.000Z' },
  paymentResolution: 'PROCESSING', amendment: null, events: [],
}

beforeEach(() => {
  mocks.api.mockReset()
  vi.stubGlobal('confirm', vi.fn(() => true))
})
afterEach(() => vi.unstubAllGlobals())

describe('OrderTrackingView online cancellation', () => {
  it('explains automatic refund while canceled payment remains under analysis', async () => {
    mocks.api.mockResolvedValueOnce({ ...baseOrder, status: 'CANCELLED', paymentResolution: 'PROCESSING' })
    const wrapper = mount(OrderTrackingView, {
      global: { stubs: { RouterLink: { template: '<a><slot /></a>' } } },
    })
    await flushPromises()
    expect(wrapper.text()).toContain('O pagamento ainda está em análise')
    expect(wrapper.text()).toContain('o estorno será realizado automaticamente')
    wrapper.unmount()
  })

  it('shows card processing deadline and cancels directly from awaiting payment', async () => {
    mocks.api.mockResolvedValueOnce(baseOrder).mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce({
      ...baseOrder,
      status: 'CANCELLED',
      cancelReason: 'Cancelado pelo cliente',
      payment: null,
      paymentResolution: 'NOT_CHARGED',
    })
    const wrapper = mount(OrderTrackingView, {
      global: { stubs: { RouterLink: { template: '<a><slot /></a>' } } },
    })
    await flushPromises()

    expect(wrapper.text()).toContain('Aguardando confirmação do pagamento')
    expect(wrapper.text()).toContain('expira em')
    const cancel = wrapper.find('[data-testid="cancel-awaiting-payment"]')
    expect(cancel.exists()).toBe(true)

    await cancel.trigger('click')
    await flushPromises()
    expect(mocks.api).toHaveBeenCalledWith('/orders/order-1/cancel', {
      method: 'POST',
      body: JSON.stringify({}),
    })
    expect(wrapper.text()).toContain('nenhuma cobrança foi concluída')
    wrapper.unmount()
  })
})
