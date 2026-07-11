import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest'
import { migrateTestDb, truncateAll, testDb, closeTestDb } from './helpers/test-db'
import type { StoreCreateInput } from '@delivery/shared/schemas'
import {
  createStoreWithOwner, getStoreByOwner, getStoreBySlug, listPublicStores,
  setStoreSecurityStatus, updateStore, StoreError,
} from '../src/services/store.service'

const input: StoreCreateInput = {
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

describe('createStoreWithOwner', () => {
  it('creates STORE user + store atomically', async () => {
    const s = await createStoreWithOwner(testDb, input)
    expect(s.slug).toBe('pizzaria-do-joao')
    const byOwner = await getStoreByOwner(testDb, s.ownerUserId)
    expect(byOwner?.id).toBe(s.id)
  })

  it('rejects duplicate slug (case-insensitive) and duplicate owner email', async () => {
    await createStoreWithOwner(testDb, input)
    await expect(
      createStoreWithOwner(testDb, { ...input, slug: 'PIZZARIA-DO-JOAO'.toLowerCase(), owner: { ...input.owner, email: 'x@y.com' } }),
    ).rejects.toThrow(StoreError)
    await expect(
      createStoreWithOwner(testDb, { ...input, slug: 'outra-loja' }),
    ).rejects.toThrow(StoreError) // mesmo email de owner
  })

  it('does not leave orphan user when store insert fails', async () => {
    await createStoreWithOwner(testDb, input)
    await expect(
      createStoreWithOwner(testDb, { ...input, owner: { ...input.owner, email: 'b@y.com' } }),
    ).rejects.toThrow(StoreError) // slug dup → tx rollback
    const orphan = await testDb.query.users.findFirst({
      where: (u, { eq }) => eq(u.email, 'b@y.com'),
    })
    expect(orphan).toBeUndefined()
  })
})

describe('listPublicStores / getStoreBySlug', () => {
  it('lists only active stores with computed isOpen', async () => {
    const a = await createStoreWithOwner(testDb, input)
    const b = await createStoreWithOwner(testDb, {
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
    const s = await createStoreWithOwner(testDb, input)
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
    const s = await createStoreWithOwner(testDb, input)
    await expect(updateStore(testDb, s.id, {})).rejects.toThrow(StoreError)
    await expect(updateStore(testDb, s.id, {})).rejects.toMatchObject({ status: 400 })
  })
})

describe('setStoreSecurityStatus', () => {
  it('suspends a store, hides it publicly and permanently closes the lifecycle', async () => {
    const store = await createStoreWithOwner(testDb, input)
    const suspended = await setStoreSecurityStatus(testDb, store.id, 'SUSPENDED')
    expect(suspended.securityStatus).toBe('SUSPENDED')
    expect(await getStoreBySlug(testDb, store.slug)).toBeNull()

    const active = await setStoreSecurityStatus(testDb, store.id, 'ACTIVE')
    expect(active.securityStatus).toBe('ACTIVE')
    const closed = await setStoreSecurityStatus(testDb, store.id, 'CLOSED')
    expect(closed.securityStatus).toBe('CLOSED')
    await expect(setStoreSecurityStatus(testDb, store.id, 'ACTIVE')).rejects.toMatchObject({ status: 409 })
  })
})
