import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { createActiveStoreTestFixture, type StoreFixtureInput, closeTestDb, migrateTestDb, scheduleForNow, testDb, truncateAll } from './helpers/test-db'
import { createAddress } from '../src/services/address.service'
import { createVerifiedTestAccount } from './helpers/test-db'
import { createCategory, createProduct } from '../src/services/catalog.service'
import {
  acceptDelivery, acceptShiftDelivery, collectDelivery, confirmArrival,
  failDelivery, releaseDelivery, setAvailability, storeReleaseDriver,
} from '../src/services/dispatch.service'
import { createOrder } from '../src/services/order.service'
import { requestDriver, requestDriverOwn, storeUpdateOrderStatus } from '../src/services/order-status.service'
import {
  adminConfirmOrderReturn, confirmOrderReturn, listPendingReturns,
} from '../src/services/return.service'
import { updateStore } from '../src/services/store.service'
import { confirmLink, inviteDriver } from '../src/services/store-driver.service'
import { startShift } from '../src/services/shift.service'
import { decideActiveShiftTerms, proposeActiveShiftTerms } from '../src/services/shift-proposal.service'
import { ledgerEntries, orders, paymentOperations, payments, users } from '../src/db/schema'

const storeInput: StoreFixtureInput = {
  name: 'Loja Retorno', slug: 'loja-retorno', category: 'MERCADO', phone: '4433334444', city: 'C',
  addressText: 'Rua Loja', lat: -23.55, lng: -51.9,
  owner: { name: 'Lojista', email: 'retorno@loja.test', password: 'senha123' },
}
const person = { name: 'Ana', phone: '44999998888', password: 'senha123', role: 'CUSTOMER' as const, acceptedTerms: true as const }
let storeId: string
let ownerId: string
let customerId: string
let driverId: string
let productId: string
let addressId: string
const driverEmail = 'returns.driver@example.test'

beforeAll(migrateTestDb)
beforeEach(async () => {
  await truncateAll()
  const store = await createActiveStoreTestFixture(storeInput)
  storeId = store.id; ownerId = store.ownerUserId
  await updateStore(testDb, storeId, {
    openingHours: Array.from({ length: 7 }, (_, dow) => ({ dow, open: '00:00', close: '23:59' })),
    deliveryFeeMode: 'FIXED', deliveryFixedFeeCents: 501,
  })
  customerId = (await createVerifiedTestAccount(testDb, person, 'secret')).user.id
  addressId = (await createAddress(testDb, customerId, { addressText: 'Rua Cliente', lat: -23.56, lng: -51.9 })).id
  const category = await createCategory(testDb, storeId, { name: 'Itens' })
  productId = (await createProduct(testDb, storeId, { categoryId: category.id, name: 'Item', basePriceCents: 5_000, isAvailable: true })).id
  driverId = (await createVerifiedTestAccount(testDb, {
    ...person, name: 'Driver', email: driverEmail, phone: '44911111111', role: 'DRIVER',
  }, 'secret')).user.id
  await testDb.update(users).set({ status: 'ACTIVE' }).where(eq(users.id, driverId))
  await setAvailability(testDb, driverId, true)
})
afterAll(closeTestDb)

async function makeOrder(paymentMethod: 'CASH' | 'PIX_ONLINE' = 'CASH') {
  const { order } = await createOrder(testDb, customerId, {
    storeSlug: 'loja-retorno', fulfillment: 'DELIVERY', addressId, paymentMethod: 'CASH',
    items: [{ productId, quantity: 1, selections: [] }], idempotencyKey: crypto.randomUUID(),
  })
  if (paymentMethod === 'PIX_ONLINE') await testDb.update(orders).set({ paymentMethod }).where(eq(orders.id, order.id))
  await storeUpdateOrderStatus(testDb, storeId, order.id, 'ACCEPTED', ownerId)
  return order
}

async function assignAndCollect(fixed = false, paymentMethod: 'CASH' | 'PIX_ONLINE' = 'CASH') {
  const order = await makeOrder(paymentMethod)
  if (fixed) {
    await requestDriverOwn(testDb, storeId, order.id)
    await acceptShiftDelivery(testDb, driverId, order.id)
  } else {
    await requestDriver(testDb, storeId, order.id)
    await acceptDelivery(testDb, driverId, order.id)
  }
  await storeUpdateOrderStatus(testDb, storeId, order.id, 'PREPARING', ownerId)
  await storeUpdateOrderStatus(testDb, storeId, order.id, 'READY', ownerId)
  await collectDelivery(testDb, driverId, order.id)
  return order
}

describe('devolução após falha', () => {
  it('estorna online, não paga na falha e libera frete freelance só na devolução', async () => {
    const order = await assignAndCollect(false, 'PIX_ONLINE')
    await testDb.insert(payments).values({
      orderId: order.id, providerOrderId: 'mp-return', method: 'PIX', expectedAmountCents: 5_501, expectedCurrency: 'BRL', expectedCountry: 'BR', expectedApplicationId: 'legacy', expectedAccountId: 'legacy', expectedLiveMode: false, createIdempotencyKey: crypto.randomUUID(), status: 'APPROVED',
    })
    const failed = await failDelivery(testDb, driverId, order.id, { reason: 'NO_ANSWER' })
    expect(failed).toMatchObject({ status: 'DELIVERY_FAILED', returnDriverPayCents: 501, returnedAt: null })
    expect(failed.returnPendingAt).toBeInstanceOf(Date)
    expect((await testDb.select().from(paymentOperations).where(eq(paymentOperations.type, 'REFUND_FULL'))).length).toBe(1)
    expect((await testDb.select().from(payments).where(eq(payments.orderId, order.id)))[0]!.status).toBe('APPROVED')
    expect(await testDb.select().from(ledgerEntries).where(eq(ledgerEntries.orderId, order.id))).toEqual([])
    expect(await listPendingReturns(testDb)).toMatchObject([{ id: order.id, storeName: 'Loja Retorno', driverName: 'Driver' }])

    await confirmOrderReturn(testDb, storeId, order.id, ownerId)
    const ledger = await testDb.select().from(ledgerEntries).where(eq(ledgerEntries.orderId, order.id))
    expect(ledger.map((entry) => [entry.type, entry.amountCents])).toEqual([['DRIVER_DELIVERY_CREDIT', 501]])
    await expect(confirmOrderReturn(testDb, storeId, order.id, ownerId)).rejects.toMatchObject({ status: 409 })
  })

  it('congela o extra do fixo na falha e suporte pode confirmar a devolução', async () => {
    const link = await inviteDriver(testDb, storeId, driverEmail, { dailyRateCents: 5_000, perDeliveryCents: 700, schedule: scheduleForNow() })
    await confirmLink(testDb, driverId, link.id)
    const shift = await startShift(testDb, driverId, link.id, { lat: -23.55, lng: -51.9 })
    const order = await assignAndCollect(true)
    await failDelivery(testDb, driverId, order.id, { reason: 'WRONG_ADDRESS' })
    const proposal = await proposeActiveShiftTerms(testDb, storeId, shift.id, { dailyRateCents: 5_000, perDeliveryCents: 900, applyRetroactive: false })
    await decideActiveShiftTerms(testDb, driverId, shift.id, proposal.id, true)
    await adminConfirmOrderReturn(testDb, order.id, crypto.randomUUID())
    const ledger = await testDb.select().from(ledgerEntries).where(eq(ledgerEntries.orderId, order.id))
    expect(ledger.map((entry) => [entry.type, entry.amountCents])).toEqual([
      ['DRIVER_PER_DELIVERY_CREDIT', 700], ['STORE_PER_DELIVERY_DEBIT', -700],
    ])
  })
})

describe('chegada e meia-taxa', () => {
  it('paga metade arredondada ao freelance desvinculado depois da chegada', async () => {
    const order = await makeOrder()
    await requestDriver(testDb, storeId, order.id)
    await acceptDelivery(testDb, driverId, order.id)
    await confirmArrival(testDb, driverId, order.id, { lat: -23.55, lng: -51.9 })
    const released = await storeReleaseDriver(testDb, storeId, order.id, ownerId)
    expect(released).toMatchObject({ driverId: null, driverArrivedAt: null, driverRequestedAt: null })
    const ledger = await testDb.select().from(ledgerEntries).where(eq(ledgerEntries.orderId, order.id))
    expect(ledger.map((entry) => [entry.type, entry.amountCents])).toEqual([
      ['DRIVER_HALF_FEE_CREDIT', 251], ['STORE_HALF_FEE_DEBIT', -251],
    ])
  })

  it('não paga meia-taxa sem chegada nem para fixo', async () => {
    const first = await makeOrder()
    await requestDriver(testDb, storeId, first.id); await acceptDelivery(testDb, driverId, first.id)
    await confirmArrival(testDb, driverId, first.id, {})
    await releaseDelivery(testDb, driverId, first.id)
    await acceptDelivery(testDb, driverId, first.id)
    await storeReleaseDriver(testDb, storeId, first.id, ownerId)
    expect(await testDb.select().from(ledgerEntries).where(eq(ledgerEntries.orderId, first.id))).toEqual([])

    const link = await inviteDriver(testDb, storeId, driverEmail, { dailyRateCents: 5_000, perDeliveryCents: 700, schedule: scheduleForNow() })
    await confirmLink(testDb, driverId, link.id)
    await startShift(testDb, driverId, link.id, { lat: -23.55, lng: -51.9 })
    const fixed = await makeOrder(); await requestDriverOwn(testDb, storeId, fixed.id); await acceptShiftDelivery(testDb, driverId, fixed.id)
    await confirmArrival(testDb, driverId, fixed.id, {})
    await storeReleaseDriver(testDb, storeId, fixed.id, ownerId)
    expect(await testDb.select().from(ledgerEntries).where(eq(ledgerEntries.orderId, fixed.id))).toEqual([])
  })
})
