import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { closeTestDb, migrateTestDb, testDb, truncateAll } from './helpers/test-db'
import { createStoreWithOwner } from '../src/services/store.service'
import { createVerifiedTestAccount } from './helpers/test-db'
import { acceptOffer, createOffer, dismissOffer, listOpenOffers, listStoreOffers } from '../src/services/offer.service'
import { driverOffers, offerAcceptances, storeDrivers, users } from '../src/db/schema'
import { listDriverLinks, listStoreDrivers } from '../src/services/store-driver.service'
import { startShift } from '../src/services/shift.service'

let storeA: string
let storeB: string
let drivers: string[]

beforeAll(migrateTestDb)
beforeEach(async () => {
  await truncateAll()
  const base = { category: 'RESTAURANTE' as const, phone: '4433334444', city: 'Maringá', addressText: 'Rua A', lat: -23.4, lng: -51.9 }
  storeA = (await createStoreWithOwner(testDb, { ...base, name: 'A', slug: 'oferta-a', owner: { name: 'A', email: 'a@offers.test', password: 'senha123' } })).id
  storeB = (await createStoreWithOwner(testDb, { ...base, phone: '4433335555', name: 'B', slug: 'oferta-b', owner: { name: 'B', email: 'b@offers.test', password: 'senha123' } })).id
  drivers = []
  for (let index = 0; index < 3; index += 1) {
    const user = await createVerifiedTestAccount(testDb, { name: `Driver ${index}`, phone: `4491111111${index}`, password: 'senha123', role: 'DRIVER', acceptedTerms: true }, 'secret')
    await testDb.update(users).set({ status: 'ACTIVE' }).where(eq(users.id, user.user.id))
    drivers.push(user.user.id)
  }
})
afterAll(closeTestDb)

const weekly = (storeId: string, slots = 2, start = '11:00', end = '15:00') => createOffer(testDb, storeId, {
  dailyRateCents: 8_000, perDeliveryCents: 700, slots, start, end,
  recurrence: { kind: 'WEEKLY', days: [1] }, note: 'Levar bag',
})

describe('serviço de ofertas', () => {
  it('publica, lista aceites e cria vínculo confirmado com os termos', async () => {
    const offer = await weekly(storeA)
    expect(await listOpenOffers(testDb, drivers[0]!)).toMatchObject([{ id: offer.id, storeName: 'A' }])
    const accepted = await acceptOffer(testDb, drivers[0]!, offer.id)
    expect(accepted.link).toMatchObject({ status: 'CONFIRMED', dailyRateCents: 8_000, schedule: [{ dow: 1, start: '11:00', end: '15:00' }] })
    expect(await listOpenOffers(testDb, drivers[0]!)).toHaveLength(0)
    expect(await listStoreOffers(testDb, storeA)).toMatchObject([{ id: offer.id, acceptedCount: 1, acceptances: [{ driverName: 'Driver 0' }] }])
  })

  it('bloqueia conflito antes de gastar vaga', async () => {
    await acceptOffer(testDb, drivers[0]!, (await weekly(storeA)).id)
    const conflict = await weekly(storeB, 1, '13:00', '19:00')
    await expect(acceptOffer(testDb, drivers[0]!, conflict.id)).rejects.toMatchObject({ status: 409, message: expect.stringContaining('Conflito') })
    expect((await testDb.select().from(driverOffers).where(eq(driverOffers.id, conflict.id)))[0]!.acceptedCount).toBe(0)
  })

  it('serializa a última vaga e retorna esgotada ao perdedor', async () => {
    const offer = await weekly(storeA, 1)
    const result = await Promise.allSettled([acceptOffer(testDb, drivers[0]!, offer.id), acceptOffer(testDb, drivers[1]!, offer.id)])
    expect(result.filter((item) => item.status === 'fulfilled')).toHaveLength(1)
    const rejection = result.find((item) => item.status === 'rejected') as PromiseRejectedResult
    expect(rejection.reason).toMatchObject({ status: 409, message: 'Vagas esgotadas' })
    expect((await testDb.select().from(driverOffers).where(eq(driverOffers.id, offer.id)))[0]).toMatchObject({ acceptedCount: 1, status: 'CLOSED' })
    expect(await testDb.select().from(offerAcceptances)).toHaveLength(1)
  })

  it('serializa dois aceites simultâneos do mesmo driver e bloqueia conflito', async () => {
    const first = await weekly(storeA, 1, '11:00', '15:00')
    const second = await weekly(storeB, 1, '13:00', '19:00')
    const result = await Promise.allSettled([acceptOffer(testDb, drivers[2]!, first.id), acceptOffer(testDb, drivers[2]!, second.id)])
    expect(result.filter((item) => item.status === 'fulfilled')).toHaveLength(1)
    const rejection = result.find((item) => item.status === 'rejected') as PromiseRejectedResult
    expect(rejection.reason).toMatchObject({ status: 409, message: expect.stringContaining('Conflito') })
    expect(await testDb.select().from(storeDrivers).where(eq(storeDrivers.driverUserId, drivers[2]!))).toHaveLength(1)
  })

  it('dispensa sem ocupar vaga e cria novo vínculo preservando removido', async () => {
    const dismissed = await weekly(storeA)
    await dismissOffer(testDb, drivers[0]!, dismissed.id)
    expect((await testDb.select().from(driverOffers).where(eq(driverOffers.id, dismissed.id)))[0]!.acceptedCount).toBe(0)
    expect(await listOpenOffers(testDb, drivers[0]!)).toHaveLength(0)

    const old = await testDb.insert(storeDrivers).values({ storeId: storeB, driverUserId: drivers[0]!, status: 'REMOVED' }).returning()
    const dated = await createOffer(testDb, storeB, { dailyRateCents: 9_000, perDeliveryCents: 900, slots: 1,
      start: '17:00', end: '03:00', recurrence: { kind: 'DATES', dates: ['2026-07-18'] },
    })
    const accepted = await acceptOffer(testDb, drivers[0]!, dated.id)
    expect(accepted.link.id).not.toBe(old[0]!.id)
    expect(accepted.link).toMatchObject({ status: 'CONFIRMED', schedule: [{ date: '2026-07-18', start: '17:00', end: '03:00' }] })
    expect(accepted.link.expiresAt).toEqual(new Date('2026-07-19T06:00:00.000Z'))
    expect(await testDb.select().from(storeDrivers).where(eq(storeDrivers.driverUserId, drivers[0]!))).toHaveLength(2)
  })

  it('oculta vínculo expirado e impede novo turno', async () => {
    const [expiredLink] = await testDb.insert(storeDrivers).values({ storeId: storeA, driverUserId: drivers[0]!, status: 'CONFIRMED',
      expiresAt: new Date(Date.now() - 60_000), schedule: [{ date: '2020-01-01', start: '09:00', end: '18:00' }],
    }).returning()
    expect(await listDriverLinks(testDb, drivers[0]!)).toHaveLength(0)
    expect(await listStoreDrivers(testDb, storeA)).toHaveLength(0)
    await expect(startShift(testDb, drivers[0]!, expiredLink!.id, { lat: -23.4, lng: -51.9 })).rejects.toMatchObject({ status: 409, message: 'Vínculo expirado' })
  })
})
