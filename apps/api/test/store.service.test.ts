import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { stores } from '../src/db/schema'
import { createActiveStoreTestFixture, type StoreFixtureInput, migrateTestDb, truncateAll, testDb, closeTestDb } from './helpers/test-db'
import {
  getStoreByOwner, getStoreBySlug, listPublicStores,
  setStoreSecurityStatus, updateStore, StoreError,
} from '../src/services/store.service'

const input: StoreFixtureInput = {
  name: 'Pizzaria do João',
  slug: 'pizzaria-do-joao',
  category: 'PIZZARIA',
  phone: '4433334444',
  city: 'Cidade Exemplo',
  addressText: 'Rua Central, 100',
  lat: -23.5,
  lng: -51.9,
  owner: { name: 'João', email: 'joao@email.com', password: 'senha123' },
}

beforeAll(migrateTestDb)
beforeEach(truncateAll)
afterAll(closeTestDb)

describe('listPublicStores / getStoreBySlug', () => {
  it('lists only active stores with computed isOpen', async () => {
    const a = await createActiveStoreTestFixture(input)
    const b = await createActiveStoreTestFixture({
      ...input, name: 'Mercado X', slug: 'mercado-x', category: 'MERCADO',
      owner: { ...input.owner, email: 'm@y.com' },
    })
    await setStoreSecurityStatus(testDb, b.id, 'SUSPENDED')
    const list = await listPublicStores(testDb)
    expect(list.map((s) => s.slug)).toEqual(['pizzaria-do-joao'])
    expect(list[0]).toHaveProperty('isOpen')
    expect(list[0]).not.toHaveProperty('ownerUserId') // shape público
    const bySlug = await getStoreBySlug(testDb, 'pizzaria-do-joao')
    expect(bySlug?.name).toBe('Pizzaria do João')
    expect(await getStoreBySlug(testDb, 'mercado-x')).toBeNull() // inativa
    void a
  })
})

describe('updateStore', () => {
  it('updates config and hours for the owner store', async () => {
    const s = await createActiveStoreTestFixture(input)
    const upd = await updateStore(testDb, s.id, {
      deliveryFeeMode: 'DISTANCE',
      deliveryMinFeeCents: 400,
      deliveryPerKmCents: 150,
      openingHours: [{ dow: 3, open: '18:00', close: '23:00' }],
      isPaused: true,
    })
    expect(upd.deliveryFeeMode).toBe('DISTANCE')
    expect(upd.isPaused).toBe(true)
    expect(upd.openingHours).toHaveLength(1)
  })

  it('rejects empty update with StoreError 400', async () => {
    const s = await createActiveStoreTestFixture(input)
    await expect(updateStore(testDb, s.id, {})).rejects.toThrow(StoreError)
    await expect(updateStore(testDb, s.id, {})).rejects.toMatchObject({ status: 400 })
  })
})

describe('setStoreSecurityStatus', () => {
  it('suspends a store, hides it publicly and permanently closes the lifecycle', async () => {
    const store = await createActiveStoreTestFixture(input)
    const suspended = await setStoreSecurityStatus(testDb, store.id, 'SUSPENDED')
    expect(suspended.securityStatus).toBe('SUSPENDED')
    expect(await getStoreBySlug(testDb, store.slug)).toBeNull()

    const active = await setStoreSecurityStatus(testDb, store.id, 'ACTIVE')
    expect(active.securityStatus).toBe('ACTIVE')
    const closed = await setStoreSecurityStatus(testDb, store.id, 'CLOSED')
    expect(closed.securityStatus).toBe('CLOSED')
    await expect(setStoreSecurityStatus(testDb, store.id, 'ACTIVE')).rejects.toMatchObject({ status: 409 })
  })

  it('keeps CLOSED terminal under concurrent close and reactivate requests', async () => {
    const store = await createActiveStoreTestFixture(input)
    await setStoreSecurityStatus(testDb, store.id, 'SUSPENDED')

    let releaseClose!: () => void
    let reportLocked!: () => void
    const closeMayCommit = new Promise<void>((resolve) => { releaseClose = resolve })
    const closeHasLock = new Promise<void>((resolve) => { reportLocked = resolve })
    const closing = testDb.transaction(async (tx) => {
      await tx.select({ id: stores.id }).from(stores).where(eq(stores.id, store.id)).for('update')
      await tx.update(stores).set({ securityStatus: 'CLOSED' }).where(eq(stores.id, store.id))
      reportLocked()
      await closeMayCommit
    })

    await closeHasLock
    const activating = setStoreSecurityStatus(testDb, store.id, 'ACTIVE')
    await new Promise((resolve) => setTimeout(resolve, 25))
    releaseClose()
    const activation = await Promise.allSettled([closing, activating])

    const current = await getStoreByOwner(testDb, store.ownerUserId)
    expect(activation[1]?.status).toBe('rejected')
    expect(current?.securityStatus).toBe('CLOSED')
  })
})
