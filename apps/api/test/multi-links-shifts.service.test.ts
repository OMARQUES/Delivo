import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { closeTestDb, migrateTestDb, testDb, truncateAll } from './helpers/test-db'
import { createStoreWithOwner } from '../src/services/store.service'
import { createVerifiedTestAccount } from './helpers/test-db'
import { confirmLink, confirmLinkTermsChange, inviteDriver, proposeLinkTerms, removeLink } from '../src/services/store-driver.service'
import { autoApproveStaleShiftDailies, decideShiftDaily, endShift, offerShiftReactivation, reactivateShift, startShift } from '../src/services/shift.service'
import { createShiftAuthorization, decideActiveShiftTerms, decideShiftAuthorization, proposeActiveShiftTerms } from '../src/services/shift-proposal.service'
import { driverShifts, ledgerEntries, storeDrivers, users } from '../src/db/schema'

let storeId: string
let storeOwnerId: string
let driverId: string
const phone = '44977770000'

function spPoint(offsetMinutes: number) {
  const now = new Date(Date.now() + offsetMinutes * 60_000)
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo', weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(now)
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? ''
  return { date: `${get('year')}-${get('month')}-${get('day')}`,
    dow: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday')),
    time: `${String(Number(get('hour')) % 24).padStart(2, '0')}:${get('minute')}`,
  }
}
function window(startOffset: number, endOffset: number) {
  const start = spPoint(startOffset); const end = spPoint(endOffset)
  return [{ dow: start.dow, start: start.time, end: end.time }]
}

beforeAll(migrateTestDb)
beforeEach(async () => {
  await truncateAll()
  const store = await createStoreWithOwner(testDb, { name: 'Multi', slug: 'multi-link', category: 'MERCADO', phone: '4433339090', city: 'C',
    addressText: 'Rua A', lat: -23.5, lng: -51.9, owner: { name: 'L', email: 'multi@link.test', password: 'senha123' },
  })
  storeId = store.id
  storeOwnerId = store.ownerUserId
  const driver = await createVerifiedTestAccount(testDb, { name: 'D', phone, password: 'senha123', role: 'DRIVER', acceptedTerms: true }, 'secret')
  driverId = driver.user.id
  await testDb.update(users).set({ status: 'ACTIVE' }).where(eq(users.id, driverId))
})
afterAll(closeTestDb)

describe('múltiplos vínculos e ocorrências', () => {
  it('serializa confirmações concorrentes de agendas sobrepostas', async () => {
    const terms = { dailyRateCents: 5_000, perDeliveryCents: 500, schedule: window(0, 60) }
    const first = await inviteDriver(testDb, storeId, phone, terms)
    const second = await inviteDriver(testDb, storeId, phone, terms)
    const result = await Promise.allSettled([confirmLink(testDb, driverId, first.id), confirmLink(testDb, driverId, second.id)])
    expect(result.filter((item) => item.status === 'fulfilled')).toHaveLength(1)
    expect(result.find((item) => item.status === 'rejected')).toMatchObject({ reason: { status: 409 } })
  })

  it('permite dois turnos disjuntos na mesma loja/dia e paga duas diárias', async () => {
    const first = await inviteDriver(testDb, storeId, phone, { dailyRateCents: 5_000, perDeliveryCents: 500, schedule: window(-29, 29) })
    await confirmLink(testDb, driverId, first.id)
    const second = await inviteDriver(testDb, storeId, phone, { dailyRateCents: 7_000, perDeliveryCents: 700, schedule: window(29, 89) })
    await confirmLink(testDb, driverId, second.id)
    const s1 = await startShift(testDb, driverId, first.id, { lat: -23.5, lng: -51.9 }); await endShift(testDb, driverId, s1.id)
    const s2 = await startShift(testDb, driverId, second.id, { lat: -23.5, lng: -51.9 }); await endShift(testDb, driverId, s2.id)
    await decideShiftDaily(testDb, storeId, storeOwnerId, s1.id, true)
    await decideShiftDaily(testDb, storeId, storeOwnerId, s2.id, true)
    expect(await testDb.select().from(driverShifts)).toHaveLength(2)
    expect((await testDb.select().from(ledgerEntries).where(eq(ledgerEntries.type, 'DRIVER_DAILY_RATE_CREDIT'))).map((item) => item.amountCents).sort()).toEqual([5_000, 7_000])
  })

  it('vínculo sem agenda não inicia e vínculo com turno ativo não é removido nem muda agenda', async () => {
    const empty = await inviteDriver(testDb, storeId, phone, { dailyRateCents: 1, perDeliveryCents: 1, schedule: [] }); await confirmLink(testDb, driverId, empty.id)
    await expect(startShift(testDb, driverId, empty.id, { lat: -23.5, lng: -51.9 })).rejects.toThrow('sem agenda')
    const active = await inviteDriver(testDb, storeId, phone, { dailyRateCents: 5_000, perDeliveryCents: 500, schedule: window(0, 60) }); await confirmLink(testDb, driverId, active.id)
    const shift = await startShift(testDb, driverId, active.id, { lat: -23.5, lng: -51.9 })
    await expect(removeLink(testDb, storeId, active.id)).rejects.toMatchObject({ status: 409 })
    await proposeLinkTerms(testDb, storeId, active.id, { schedule: window(120, 180) })
    await expect(confirmLinkTermsChange(testDb, driverId, active.id)).rejects.toMatchObject({ status: 409 })
    await endShift(testDb, driverId, shift.id)
  })

  it('autorização aceita libera início atrasado e mantém valores propostos', async () => {
    const schedule = window(-60, 90)
    const link = await inviteDriver(testDb, storeId, phone, { dailyRateCents: 5_000, perDeliveryCents: 500, schedule }); await confirmLink(testDb, driverId, link.id)
    const auth = await createShiftAuthorization(testDb, storeId, { storeDriverId: link.id, workDate: spPoint(-60).date,
      authorizedUntil: new Date(Date.now() + 30 * 60_000).toISOString(), dailyRateCents: 6_000, perDeliveryCents: 600, note: 'Compensação combinada',
    })
    await expect(startShift(testDb, driverId, link.id, { lat: -23.5, lng: -51.9 })).rejects.toThrow('Fora da janela')
    await decideShiftAuthorization(testDb, driverId, auth.id, true)
    const shift = await startShift(testDb, driverId, link.id, { lat: -23.5, lng: -51.9 })
    expect(shift).toMatchObject({ dailyRateCents: 6_000, perDeliveryCents: 600, storeDriverId: link.id })
  })

  it('reajuste ativo só altera valores após confirmação', async () => {
    const link = await inviteDriver(testDb, storeId, phone, { dailyRateCents: 5_000, perDeliveryCents: 500, schedule: window(0, 60) }); await confirmLink(testDb, driverId, link.id)
    const shift = await startShift(testDb, driverId, link.id, { lat: -23.5, lng: -51.9 })
    const proposal = await proposeActiveShiftTerms(testDb, storeId, shift.id, { dailyRateCents: 8_000, perDeliveryCents: 800, applyRetroactive: false })
    expect((await testDb.select().from(driverShifts).where(eq(driverShifts.id, shift.id)))[0]).toMatchObject({ dailyRateCents: 5_000 })
    const accepted = await decideActiveShiftTerms(testDb, driverId, shift.id, proposal.id, true)
    expect(accepted.shift).toMatchObject({ dailyRateCents: 8_000, perDeliveryCents: 800 })
    expect(await testDb.select().from(storeDrivers).where(eq(storeDrivers.driverUserId, driverId))).toHaveLength(1)
  })

  it('reativa o mesmo turno em até 30min e paga a diária uma única vez após aprovação', async () => {
    const link = await inviteDriver(testDb, storeId, phone, { dailyRateCents: 5_000, perDeliveryCents: 500, schedule: window(0, 60) }); await confirmLink(testDb, driverId, link.id)
    const shift = await startShift(testDb, driverId, link.id, { lat: -23.5, lng: -51.9 })
    const pending = await endShift(testDb, driverId, shift.id)
    expect(pending).toMatchObject({ status: 'PENDING_DAILY', dailyDecision: 'PENDING' })
    expect(await testDb.select().from(ledgerEntries).where(eq(ledgerEntries.type, 'DRIVER_DAILY_RATE_CREDIT'))).toHaveLength(0)
    await offerShiftReactivation(testDb, storeId, shift.id)
    const active = await reactivateShift(testDb, driverId, shift.id)
    expect(active).toMatchObject({ id: shift.id, status: 'ACTIVE', reopenCount: 1 })
    await endShift(testDb, driverId, shift.id)
    await decideShiftDaily(testDb, storeId, storeOwnerId, shift.id, true)
    expect(await testDb.select().from(ledgerEntries).where(eq(ledgerEntries.type, 'DRIVER_DAILY_RATE_CREDIT'))).toHaveLength(1)
  })

  it('recusa diária com motivo e autoaprova pendência vencida após 24h', async () => {
    const first = await inviteDriver(testDb, storeId, phone, { dailyRateCents: 5_000, perDeliveryCents: 500, schedule: window(-29, 29) }); await confirmLink(testDb, driverId, first.id)
    const s1 = await startShift(testDb, driverId, first.id, { lat: -23.5, lng: -51.9 }); await endShift(testDb, driverId, s1.id)
    await expect(decideShiftDaily(testDb, storeId, storeOwnerId, s1.id, false, '')).rejects.toMatchObject({ status: 400 })
    const rejected = await decideShiftDaily(testDb, storeId, storeOwnerId, s1.id, false, 'Turno não cumprido')
    expect(rejected).toMatchObject({ status: 'CLOSED', dailyDecision: 'REJECTED' })

    const second = await inviteDriver(testDb, storeId, phone, { dailyRateCents: 7_000, perDeliveryCents: 700, schedule: window(29, 89) }); await confirmLink(testDb, driverId, second.id)
    const s2 = await startShift(testDb, driverId, second.id, { lat: -23.5, lng: -51.9 }); await endShift(testDb, driverId, s2.id)
    const future = new Date(Date.now() + 25 * 60 * 60_000)
    expect(await autoApproveStaleShiftDailies(testDb, future)).toBe(1)
    expect((await testDb.select().from(driverShifts).where(eq(driverShifts.id, s2.id)))[0]).toMatchObject({ status: 'CLOSED', dailyDecision: 'APPROVED' })
    expect((await testDb.select().from(ledgerEntries).where(eq(ledgerEntries.type, 'DRIVER_DAILY_RATE_CREDIT'))).map((item) => item.amountCents)).toEqual([7_000])
  })
})
