import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import StoreDriversView from './StoreDriversView.vue'

const link = {
  id: '123e4567-e89b-42d3-a456-426614174000',
  driverUserId: '223e4567-e89b-42d3-a456-426614174000',
  driverName: 'Entregadora',
  driverPhone: '44999990000',
  status: 'CONFIRMED',
  dailyRateCents: 5000,
  perDeliveryCents: 500,
  schedule: [{ dow: 1, start: '09:00', end: '18:00' }],
  pendingDailyRateCents: null,
  pendingPerDeliveryCents: null,
  pendingSchedule: null,
  pendingProposedAt: null,
}

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status })
}

let wrapper: VueWrapper | undefined

beforeEach(() => {
  vi.restoreAllMocks()
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
})

describe('StoreDriversView', () => {
  it('invites by email while preserving the driver contact phone display', async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response([link]))
      .mockResolvedValueOnce(response([]))
      .mockResolvedValueOnce(response({ id: 'invitation-id' }, 201))
      .mockResolvedValueOnce(response([link]))
      .mockResolvedValueOnce(response([]))
    vi.stubGlobal('fetch', fetchMock)
    wrapper = mount(StoreDriversView)
    await flushPromises()

    expect(wrapper.text()).toContain('44999990000')
    const email = wrapper.get('input[placeholder="Email do entregador"]')
    expect(email.attributes('type')).toBe('email')
    expect(email.attributes('autocomplete')).toBe('email')
    await email.setValue('driver@example.test')
    await wrapper.get('input[placeholder="Diária (R$)"]').setValue('50,00')
    await wrapper.get('input[placeholder="Extra/entrega (R$)"]').setValue('5,00')
    await wrapper.get('form').trigger('submit.prevent')
    await flushPromises()

    const post = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST')
    expect(post?.[0]).toContain('/store/me/drivers')
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({
      email: 'driver@example.test',
      dailyRateCents: 5000,
      perDeliveryCents: 500,
      schedule: [{ dow: 1, start: '09:00', end: '18:00' }],
    })
  })
})
