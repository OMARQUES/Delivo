import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq, isNull } from 'drizzle-orm'
import type { StoreCreateInput } from '@delivery/shared/schemas'
import { closeTestDb, migrateTestDb, scheduleForNow, testDb, truncateAll } from './helpers/test-db'
import { createVerifiedTestAccount } from './helpers/test-db'
import { createStoreWithOwner, updateStore } from '../src/services/store.service'
import { createAddress } from '../src/services/address.service'
import { createCategory, createProduct } from '../src/services/catalog.service'
import { createOrder } from '../src/services/order.service'
import {
  confirmLink, confirmLinkTermsChange, inviteDriver, proposeLinkTerms,
  rejectLinkTermsChange, removeLink,
} from '../src/services/store-driver.service'
import { decideShiftDaily, endShift, startShift } from '../src/services/shift.service'
import { decideActiveShiftTerms, proposeActiveShiftTerms } from '../src/services/shift-proposal.service'
import {
  listAvailableDriverTokens, listShiftDriverTokens, requestDriver, requestDriverOwn,
  requestDriverSpecific, storeUpdateOrderStatus, withdrawDriverRequest,
} from '../src/services/order-status.service'
import {
  acceptDelivery, acceptShiftDelivery, collectDelivery, completeDelivery,
  listAvailableDeliveries, listShiftDeliveries, refuseDirectDelivery,
  setAvailability, setFcmToken,
} from '../src/services/dispatch.service'
import { driverShifts, ledgerEntries, orders, storeDrivers, stores, users } from '../src/db/schema'

const storeInput: StoreCreateInput = {
  name: 'Loja Turno', slug: 'loja-turno', category: 'MERCADO', phone: '4433334444', city: 'C',
  addressText: 'Rua A, 1', lat: -23.55, lng: -51.9,
  owner: { name: 'Lojista', email: 'turno@loja.test', password: 'senha123' },
}
const customerInput = { name: 'Ana', phone: '44999998888', password: 'senha123', role: 'CUSTOMER' as const, acceptedTerms: true as const }
let storeId: string
let driverId: string
let freelanceId: string
let customerId: string
let productId: string
let addressId: string

beforeAll(migrateTestDb)
beforeEach(async () => {
  await truncateAll()
  const store = await createStoreWithOwner(testDb, storeInput)
  storeId = store.id
  await updateStore(testDb, storeId, {
    openingHours: Array.from({ length: 7 }, (_, dow) => ({ dow, open: '00:00', close: '23:59' })),
    deliveryFeeMode: 'FIXED', deliveryFixedFeeCents: 500,
  })
  await testDb.update(stores).set({ commissionBps: 1000 }).where(eq(stores.id, storeId))
  const customer = await createVerifiedTestAccount(testDb, customerInput, 'secret')
  customerId = customer.user.id
  addressId = (await createAddress(testDb, customerId, { addressText: 'Rua B', lat: -23.56, lng: -51.9 })).id
  const category = await createCategory(testDb, storeId, { name: 'Itens' })
  productId = (await createProduct(testDb, storeId, { categoryId: category.id, name: 'Item', basePriceCents: 10_000, isAvailable: true })).id
  driverId = (await createVerifiedTestAccount(testDb, { ...customerInput, name: 'Fixo', phone: '44911111111', role: 'DRIVER' }, 'secret')).user.id
  freelanceId = (await createVerifiedTestAccount(testDb, { ...customerInput, name: 'Freela', phone: '44922222222', role: 'DRIVER' }, 'secret')).user.id
  await testDb.update(users).set({ status: 'ACTIVE' }).where(eq(users.id, driverId))
  await testDb.update(users).set({ status: 'ACTIVE' }).where(eq(users.id, freelanceId))
  await setAvailability(testDb, driverId, true)
  await setAvailability(testDb, freelanceId, true)
})
afterAll(closeTestDb)

async function makeOrder(paymentMethod: 'CASH' | 'PIX_ONLINE' = 'CASH') {
  const { order } = await createOrder(testDb, customerId, {
    storeSlug: 'loja-turno', fulfillment: 'DELIVERY', addressId, paymentMethod: 'CASH',
    items: [{ productId, quantity: 1, selections: [] }], idempotencyKey: crypto.randomUUID(),
  })
  if (paymentMethod !== 'CASH') await testDb.update(orders).set({ paymentMethod }).where(eq(orders.id, order.id))
  await storeUpdateOrderStatus(testDb, storeId, order.id, 'ACCEPTED', customerId)
  return order
}

async function deliverOwn() {
  const order = await makeOrder('CASH')
  await requestDriverOwn(testDb, storeId, order.id)
  await acceptShiftDelivery(testDb, driverId, order.id)
  await storeUpdateOrderStatus(testDb, storeId, order.id, 'PREPARING', customerId)
  await storeUpdateOrderStatus(testDb, storeId, order.id, 'READY', customerId)
  await collectDelivery(testDb, driverId, order.id)
  await completeDelivery(testDb, driverId, order.id)
  return order
}

describe('entregadores próprios', () => {
  it('não encerra enquanto houver entrega associada em andamento', async () => {
    const link = await inviteDriver(testDb, storeId, '44 91111-1111', {
      dailyRateCents: 5_000, perDeliveryCents: 500, schedule: scheduleForNow(),
    })
    await confirmLink(testDb, driverId, link.id)
    const shift = await startShift(testDb, driverId, link.id, { lat: -23.55, lng: -51.9 })
    const order = await makeOrder()
    await requestDriverOwn(testDb, storeId, order.id)
    await acceptShiftDelivery(testDb, driverId, order.id)
    await expect(endShift(testDb, driverId, shift.id)).rejects.toThrow('Finalize ou devolva')
  })

  it('isola o broadcast, congela valores e lança extra + diária de forma idempotente', async () => {
    const link = await inviteDriver(testDb, storeId, '44 91111-1111', {
      dailyRateCents: 8_000, perDeliveryCents: 700, schedule: scheduleForNow(),
    })
    await confirmLink(testDb, driverId, link.id)
    await expect(startShift(testDb, driverId, link.id, { lat: -24.55, lng: -51.9 })).rejects.toThrow('fora do raio')
    const shift = await startShift(testDb, driverId, link.id, { lat: -23.55, lng: -51.9 })
    await proposeLinkTerms(testDb, storeId, link.id, { dailyRateCents: 20_000, perDeliveryCents: 2_000 })
    expect(shift).toMatchObject({ dailyRateCents: 8_000, perDeliveryCents: 700, status: 'ACTIVE' })
    await expect(startShift(testDb, driverId, link.id, { lat: -23.55, lng: -51.9 })).rejects.toThrow('turno')

    const order = await makeOrder('PIX_ONLINE')
    await requestDriverOwn(testDb, storeId, order.id)
    expect(await listAvailableDeliveries(testDb, freelanceId)).toHaveLength(0)
    await expect(acceptDelivery(testDb, freelanceId, order.id)).rejects.toThrow('não está disponível')
    expect(await listAvailableDeliveries(testDb, driverId)).toHaveLength(0)
    expect(await listShiftDeliveries(testDb, driverId)).toHaveLength(1)

    await acceptShiftDelivery(testDb, driverId, order.id)
    const [assigned] = await testDb.select().from(orders).where(eq(orders.id, order.id))
    expect(assigned).toMatchObject({ driverId, shiftId: shift.id })
    await storeUpdateOrderStatus(testDb, storeId, order.id, 'PREPARING', customerId)
    await storeUpdateOrderStatus(testDb, storeId, order.id, 'READY', customerId)
    await collectDelivery(testDb, driverId, order.id)
    await completeDelivery(testDb, driverId, order.id)

    const orderEntries = await testDb.select().from(ledgerEntries).where(eq(ledgerEntries.orderId, order.id))
    expect(orderEntries.map((entry) => [entry.type, entry.amountCents])).toEqual([
      ['STORE_SALE_CREDIT', 9_500],
      ['DRIVER_PER_DELIVERY_CREDIT', 700],
      ['STORE_PER_DELIVERY_DEBIT', -700],
    ])

    await endShift(testDb, driverId, shift.id)
    await decideShiftDaily(testDb, storeId, customerId, shift.id, true)
    const daily = await testDb.select().from(ledgerEntries).where(isNull(ledgerEntries.orderId))
    expect(daily.map((entry) => [entry.type, entry.amountCents])).toEqual([
      ['DRIVER_DAILY_RATE_CREDIT', 8_000],
      ['STORE_DAILY_RATE_DEBIT', -8_000],
    ])
    expect((await testDb.select().from(driverShifts).where(eq(driverShifts.id, shift.id)))[0]).toMatchObject({ status: 'CLOSED', closedBy: 'DRIVER' })
    await expect(endShift(testDb, driverId, shift.id)).rejects.toThrow('não encontrado')
    expect(await testDb.select().from(ledgerEntries).where(isNull(ledgerEntries.orderId))).toHaveLength(2)
  })

  it('mantém termos ativos até confirmação e permite recusar a proposta', async () => {
    const schedule = [{ dow: 1, start: '09:00', end: '18:00' }]
    const link = await inviteDriver(testDb, storeId, '44 91111-1111', {
      dailyRateCents: 5_000, perDeliveryCents: 500, schedule,
    })
    await confirmLink(testDb, driverId, link.id)

    const proposed = await proposeLinkTerms(testDb, storeId, link.id, {
      dailyRateCents: 7_000, perDeliveryCents: 800,
    })
    expect(proposed).toMatchObject({
      dailyRateCents: 5_000, perDeliveryCents: 500,
      pendingDailyRateCents: 7_000, pendingPerDeliveryCents: 800,
      pendingSchedule: schedule,
    })
    expect(proposed.pendingProposedAt).toBeInstanceOf(Date)
    await expect(confirmLinkTermsChange(testDb, freelanceId, link.id)).rejects.toMatchObject({ status: 404 })

    const confirmed = await confirmLinkTermsChange(testDb, driverId, link.id)
    expect(confirmed).toMatchObject({
      dailyRateCents: 7_000, perDeliveryCents: 800,
      pendingDailyRateCents: null, pendingProposedAt: null,
    })
    await expect(confirmLinkTermsChange(testDb, driverId, link.id)).rejects.toThrow('Sem alteração pendente')

    await proposeLinkTerms(testDb, storeId, link.id, { dailyRateCents: 9_000 })
    const rejected = await rejectLinkTermsChange(testDb, driverId, link.id)
    expect(rejected).toMatchObject({ dailyRateCents: 7_000, perDeliveryCents: 800, pendingProposedAt: null })
    await expect(rejectLinkTermsChange(testDb, driverId, link.id)).rejects.toThrow('Sem alteração pendente')
  })

  it('reconcilia retroativo pelo saldo real de cada pedido e usa novos valores no futuro', async () => {
    const link = await inviteDriver(testDb, storeId, '44 91111-1111', {
      dailyRateCents: 5_000, perDeliveryCents: 500, schedule: scheduleForNow(),
    })
    await confirmLink(testDb, driverId, link.id)
    const shift = await startShift(testDb, driverId, link.id, { lat: -23.55, lng: -51.9 })

    const first = await deliverOwn() // 500
    const firstProposal = await proposeActiveShiftTerms(testDb, storeId, shift.id, { dailyRateCents: 5_000, perDeliveryCents: 700, applyRetroactive: false })
    await decideActiveShiftTerms(testDb, driverId, shift.id, firstProposal.id, true)
    const second = await deliverOwn() // 700
    const secondProposal = await proposeActiveShiftTerms(testDb, storeId, shift.id, {
      dailyRateCents: 9_000, perDeliveryCents: 800, applyRetroactive: true,
    })
    const adjusted = await decideActiveShiftTerms(testDb, driverId, shift.id, secondProposal.id, true)
    expect(adjusted.shift).toMatchObject({ dailyRateCents: 9_000, perDeliveryCents: 800, adjustmentSeq: 2 })

    const driverCredits = await testDb.select().from(ledgerEntries).where(eq(ledgerEntries.type, 'DRIVER_PER_DELIVERY_CREDIT'))
    const sumFor = (orderId: string) => driverCredits
      .filter((entry) => entry.orderId === orderId)
      .reduce((sum, entry) => sum + entry.amountCents, 0)
    expect(sumFor(first.id)).toBe(800)
    expect(sumFor(second.id)).toBe(800)

    const third = await deliverOwn()
    const afterThird = await testDb.select().from(ledgerEntries).where(eq(ledgerEntries.type, 'DRIVER_PER_DELIVERY_CREDIT'))
    expect(afterThird.filter((entry) => entry.orderId === third.id).reduce((sum, entry) => sum + entry.amountCents, 0)).toBe(800)

    const countBeforeRetry = afterThird.length
    const retryProposal = await proposeActiveShiftTerms(testDb, storeId, shift.id, { dailyRateCents: 9_000, perDeliveryCents: 800, applyRetroactive: true })
    await decideActiveShiftTerms(testDb, driverId, shift.id, retryProposal.id, true)
    expect(await testDb.select().from(ledgerEntries).where(eq(ledgerEntries.type, 'DRIVER_PER_DELIVERY_CREDIT'))).toHaveLength(countBeforeRetry)
    await expect(proposeActiveShiftTerms(testDb, crypto.randomUUID(), shift.id, { dailyRateCents: 1, perDeliveryCents: 800, applyRetroactive: false })).rejects.toMatchObject({ status: 404 })

    await endShift(testDb, driverId, shift.id)
    await decideShiftDaily(testDb, storeId, customerId, shift.id, true)
    const daily = await testDb.select().from(ledgerEntries).where(eq(ledgerEntries.type, 'DRIVER_DAILY_RATE_CREDIT'))
    expect(daily).toHaveLength(1)
    expect(daily[0]!.amountCents).toBe(9_000)
  })

  it('reconvidar após remover cria novo vínculo e preserva histórico', async () => {
    const first = await inviteDriver(testDb, storeId, '44 91111-1111', { dailyRateCents: 5_000, perDeliveryCents: 500, schedule: [] })
    await removeLink(testDb, storeId, first.id)
    // Um novo convite cria uma nova identidade; o removido permanece histórico.
    const again = await inviteDriver(testDb, storeId, '44 91111-1111', { dailyRateCents: 9_000, perDeliveryCents: 900, schedule: [] })
    expect(again.id).not.toBe(first.id)
    expect(again).toMatchObject({ status: 'INVITED', dailyRateCents: 9_000, perDeliveryCents: 900 })
    expect(await testDb.select().from(storeDrivers).where(eq(storeDrivers.driverUserId, driverId))).toHaveLength(2)
  })

  it('loja escala OWN → pool geral explicitamente (sem fallback automático)', async () => {
    const order = await makeOrder('CASH')
    await requestDriverOwn(testDb, storeId, order.id)
    // preso no OWN: freelance não vê
    expect(await listAvailableDeliveries(testDb, freelanceId)).toHaveLength(0)
    // loja confirma a escalada chamando o request geral
    const escalated = await requestDriver(testDb, storeId, order.id)
    expect(escalated.driverRequestTarget).toBe('GENERAL')
    // agora o pool geral vê e aceita
    expect(await listAvailableDeliveries(testDb, freelanceId)).toHaveLength(1)
    await acceptDelivery(testDb, freelanceId, order.id)
    // GENERAL não regride pra OWN
    await expect(requestDriverOwn(testDb, storeId, order.id)).rejects.toThrow()
  })

  it('loja retira o chamado do pool geral (withdraw) e pode redirecionar do zero', async () => {
    const order = await makeOrder('CASH')
    await storeUpdateOrderStatus(testDb, storeId, order.id, 'PREPARING', customerId)
    await storeUpdateOrderStatus(testDb, storeId, order.id, 'READY', customerId)
    await requestDriver(testDb, storeId, order.id) // READY -> AWAITING_DRIVER
    expect(await listAvailableDeliveries(testDb, freelanceId)).toHaveLength(1)

    const withdrawn = await withdrawDriverRequest(testDb, storeId, order.id, customerId)
    expect(withdrawn).toMatchObject({ driverRequestedAt: null, driverRequestTarget: null, status: 'READY' })
    // some do pool
    expect(await listAvailableDeliveries(testDb, freelanceId)).toHaveLength(0)
    // pós-withdraw pode escolher own de novo (não é regressão do GENERAL — chamado foi retirado)
    const own = await requestDriverOwn(testDb, storeId, order.id)
    expect(own.driverRequestTarget).toBe('OWN')
    // sem chamado ativo -> 409; com entregador -> 409
    await withdrawDriverRequest(testDb, storeId, order.id, customerId)
    await expect(withdrawDriverRequest(testDb, storeId, order.id, customerId)).rejects.toMatchObject({ status: 409 })
    await requestDriver(testDb, storeId, order.id)
    await acceptDelivery(testDb, freelanceId, order.id)
    await expect(withdrawDriverRequest(testDb, storeId, order.id, customerId)).rejects.toMatchObject({ status: 409 })
  })

  it('direciona a um entregador, permite recusa e redirecionamento explícito', async () => {
    for (const [id, phone] of [[driverId, '44911111111'], [freelanceId, '44922222222']] as const) {
      const link = await inviteDriver(testDb, storeId, phone, { dailyRateCents: 5_000, perDeliveryCents: 500, schedule: scheduleForNow() })
      await confirmLink(testDb, id, link.id)
      await startShift(testDb, id, link.id, { lat: -23.55, lng: -51.9 })
    }
    await setFcmToken(testDb, driverId, 'token-direto-123')
    await setFcmToken(testDb, freelanceId, 'token-outro-456')
    const order = await makeOrder()
    await requestDriverSpecific(testDb, storeId, order.id, driverId)
    expect(await listShiftDeliveries(testDb, freelanceId)).toHaveLength(0)
    expect(await listShiftDeliveries(testDb, driverId)).toMatchObject([
      { orderId: order.id, driverRequestTarget: 'SPECIFIC', requestedDriverId: driverId },
    ])
    await expect(acceptShiftDelivery(testDb, freelanceId, order.id)).rejects.toMatchObject({ status: 409 })
    await expect(refuseDirectDelivery(testDb, freelanceId, order.id)).rejects.toMatchObject({ status: 409 })
    await refuseDirectDelivery(testDb, driverId, order.id)
    expect(await listShiftDeliveries(testDb, driverId)).toHaveLength(0)

    await requestDriverOwn(testDb, storeId, order.id)
    expect(await listShiftDeliveries(testDb, freelanceId)).toHaveLength(1)
    await acceptShiftDelivery(testDb, freelanceId, order.id)
    expect((await testDb.select().from(orders).where(eq(orders.id, order.id)))[0]).toMatchObject({
      driverId: freelanceId, driverRequestTarget: 'OWN', driverRequestRefusedAt: null,
    })

    expect(await listShiftDriverTokens(testDb, storeId, driverId)).toEqual(['token-direto-123'])
    expect(await listAvailableDriverTokens(testDb)).toEqual([])
  })

  it('serializa início de turno com aceite do pool geral', async () => {
    const link = await inviteDriver(testDb, storeId, '44911111111', {
      dailyRateCents: 5_000, perDeliveryCents: 500, schedule: scheduleForNow(),
    })
    await confirmLink(testDb, driverId, link.id)
    const order = await makeOrder()
    await requestDriver(testDb, storeId, order.id)
    const results = await Promise.allSettled([
      startShift(testDb, driverId, link.id, { lat: -23.55, lng: -51.9 }),
      acceptDelivery(testDb, driverId, order.id),
    ])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    const [activeShift] = await testDb.select().from(driverShifts).where(eq(driverShifts.driverUserId, driverId))
    const [assigned] = await testDb.select().from(orders).where(eq(orders.id, order.id))
    expect(Boolean(activeShift) && assigned!.driverId === driverId).toBe(false)
  })
})
