<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, provide, ref } from 'vue'
import { useRouter } from 'vue-router'
import { api } from '../lib/api'
import { enablePush, pushConfigured } from '../lib/push'
import { useAuthStore } from '../stores/auth'
import { findStartOccurrence } from '@delivery/shared'
import { formatBRL } from '@delivery/shared/constants'

const auth = useAuthStore()
const router = useRouter()
const isAvailable = ref(false)
const saving = ref(false)
const showPushButton = ref(pushConfigured())
const pixKey = ref('')
const pixMsg = ref('')
const savingPix = ref(false)
type ScheduleItem = ({ dow: number } | { date: string }) & { start: string; end: string }
type TermProposal = { id: string; dailyRateCents: number; perDeliveryCents: number; applyRetroactive: boolean; note: string | null }
type Shift = { id: string; storeName: string; storeAddressText: string; startedAt: string; pendingTerms: TermProposal | null }
type Link = { id: string; storeId: string; storeName: string; status: string; schedule: ScheduleItem[] }
type Authorization = { id: string; storeDriverId: string; workDate: string; status: 'PENDING' | 'ACCEPTED'; authorizedUntil: string; scheduledEndAt: string; dailyRateCents: number; perDeliveryCents: number; note: string }
type RecentShift = { id: string; storeDriverId: string; workDate: string; status: 'ACTIVE' | 'PENDING_DAILY' | 'REOPEN_ALLOWED' | 'CLOSED'; dailyDecision: 'PENDING' | 'APPROVED' | 'REJECTED' | null; dailyDecisionReason: string | null; reopenUntil: string | null; dailyRateCents: number }
const shift = ref<Shift | null>(null)
const links = ref<Link[]>([])
const shiftBusy = ref(false)
const shiftMsg = ref('')
const authorizations = ref<Authorization[]>([])
const recentShifts = ref<RecentShift[]>([])
const now = ref(Date.now())
let clock: ReturnType<typeof setInterval> | undefined
let syncClock: ReturnType<typeof setInterval> | undefined

async function loadShift() {
  const [active, allLinks, pendingAuthorizations, recent] = await Promise.all([
    api<Shift | null>('/driver/shifts/active'), api<Link[]>('/driver/links'),
    api<Authorization[]>('/driver/shift-authorizations'),
    api<RecentShift[]>('/driver/shifts/recent'),
  ])
  shift.value = active
  links.value = allLinks.filter((link) => link.status === 'CONFIRMED')
  authorizations.value = pendingAuthorizations
  recentShifts.value = recent
}

const DOW = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb']
const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** minuto-do-dia + dia-da-semana no fuso de São Paulo */
function spNow(ts: number) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Sao_Paulo', hour12: false, weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(new Date(ts))
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? ''
  const dow = WD.indexOf(get('weekday'))
  return { dow, date: `${get('year')}-${get('month')}-${get('day')}`, minutes: Number(get('hour')) * 60 + Number(get('minute')) }
}
function toMin(hhmm: string) { const [h, m] = hhmm.split(':'); return Number(h) * 60 + Number(m) }
function civilDay(date: string) { const [y, m, d] = date.split('-').map(Number); return Math.floor(Date.UTC(y!, m! - 1, d!) / 86_400_000) }
function datePlus(date: string, delta: number) { return new Date((civilDay(date) + delta) * 86_400_000).toISOString().slice(0, 10) }

/** próximo turno agendado (recorrência semanal) a partir de agora, no fuso SP */
const nextShift = computed(() => {
  if (shift.value) return null
  const { dow, date, minutes } = spNow(now.value)
  let best: { store: string; item: ScheduleItem; minutesUntil: number } | null = null
  for (const link of links.value) {
    for (const item of link.schedule ?? []) {
      const start = toMin(item.start)
      let until: number
      if ('date' in item) {
        until = (civilDay(item.date) - civilDay(date)) * 1440 + start - minutes
        if (until <= 0) continue
      } else {
        const delta = (item.dow - dow + 7) % 7
        until = delta * 1440 + (start - minutes)
        if (until <= 0) until += 7 * 1440
      }
      if (!best || until < best.minutesUntil) best = { store: link.storeName, item, minutesUntil: until }
    }
  }
  return best
})

/** janela de hoje em andamento (início já passou, ainda não terminou) — sem trava, só aviso */
const openWindow = computed(() => {
  if (shift.value) return null
  const { dow, date, minutes } = spNow(now.value)
  for (const link of links.value) {
    for (const item of link.schedule ?? []) {
      const start = toMin(item.start); let end = toMin(item.end)
      const today = 'date' in item ? item.date === date : item.dow === dow
      if (today && minutes >= start && (end > start ? minutes < end : true)) return { store: link.storeName, item }
      const yesterday = 'date' in item ? item.date === datePlus(date, -1) : item.dow === (dow + 6) % 7
      if (yesterday && end <= start && minutes < end) return { store: link.storeName, item }
    }
  }
  return null
})

const nextLabel = computed(() => {
  const n = nextShift.value
  if (!n) return ''
  const h = Math.floor(n.minutesUntil / 60); const m = n.minutesUntil % 60
  const tempo = h > 0 ? `${h}h ${m}min` : `${m}min`
  const when = 'date' in n.item ? n.item.date.split('-').reverse().slice(0, 2).join('/') : DOW[n.item.dow]
  return `${n.store} · ${when} ${n.item.start} — em ${tempo}`
})
// lembrete: falta 1h ou menos pro próximo turno
const soon = computed(() => nextShift.value != null && nextShift.value.minutesUntil <= 60)

// telas filhas (ex.: Minhas lojas) chamam após confirmar convite para a barra atualizar sem F5
provide('reloadDriverBar', loadShift)

onMounted(async () => {
  try {
    const me = await api<{ isAvailable: boolean; pixKey?: string | null }>('/driver/me')
    isAvailable.value = me.isAvailable
    pixKey.value = me.pixKey ?? ''
    await loadShift()
  } catch {
    // token invalido: guard resolve na proxima navegacao.
  }
  clock = setInterval(() => { now.value = Date.now() }, 1_000)
  syncClock = setInterval(() => { void loadShift() }, 15_000)
})
onBeforeUnmount(() => { clearInterval(clock); clearInterval(syncClock) })

async function toggle() {
  saving.value = true
  try {
    const r = await api<{ isAvailable: boolean }>('/driver/me/availability', {
      method: 'PATCH',
      body: JSON.stringify({ isAvailable: !isAvailable.value }),
    })
    isAvailable.value = r.isAvailable
  } finally {
    saving.value = false
  }
}

async function start(storeId: string) {
  shiftBusy.value = true
  shiftMsg.value = ''
  try {
    const gps = await new Promise<GeolocationPosition>((resolve, reject) =>
      navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, timeout: 15_000 }),
    )
    await api('/driver/shifts', { method: 'POST', body: JSON.stringify({ storeDriverId: storeId, lat: gps.coords.latitude, lng: gps.coords.longitude }) })
    await loadShift()
  } catch (e) { shiftMsg.value = e instanceof Error ? e.message : 'Não foi possível obter sua localização' }
  finally { shiftBusy.value = false }
}

function linkWindowLabel(link: Link) {
  if (!link.schedule.length) return 'Sem agenda'
  return link.schedule.map((item) => `${'date' in item ? item.date.split('-').reverse().slice(0, 2).join('/') : DOW[item.dow]} ${item.start}–${item.end}`).join(' · ')
}

function acceptedAuthorization(linkId: string) {
  return authorizations.value.find((item) => item.storeDriverId === linkId && item.status === 'ACCEPTED' && new Date() < new Date(item.authorizedUntil))
}

function occurrenceUsed(link: Link) {
  const occurrence = findStartOccurrence(link.schedule, new Date(), 30)
  const authorization = acceptedAuthorization(link.id)
  const workDate = occurrence?.workDate ?? authorization?.workDate ?? null
  return Boolean(workDate && recentShifts.value.some((shift) => shift.storeDriverId === link.id && shift.workDate === workDate))
}

function canStart(link: Link) {
  const occurrence = findStartOccurrence(link.schedule, new Date(), 30)
  const authorization = acceptedAuthorization(link.id)
  return link.schedule.length > 0 && !occurrenceUsed(link) && (occurrence != null || authorization != null)
}

function startReason(link: Link) {
  if (!link.schedule.length) return 'Sem agenda'
  if (occurrenceUsed(link)) return 'Ocorrência já utilizada'
  if (acceptedAuthorization(link.id)) return 'Início excepcional liberado'
  return canStart(link) ? 'No horário' : 'Fora da janela ±30 min'
}

async function decideAuthorization(id: string, decision: 'accept' | 'reject') {
  try { await api(`/driver/shift-authorizations/${id}/${decision}`, { method: 'POST' }); await loadShift() }
  catch (e) { shiftMsg.value = e instanceof Error ? e.message : 'Erro' }
}

async function decideShiftTerms(proposalId: string, decision: 'accept' | 'reject') {
  if (!shift.value) return
  try { await api(`/driver/shifts/${shift.value.id}/terms/${proposalId}/${decision}`, { method: 'POST' }); await loadShift() }
  catch (e) { shiftMsg.value = e instanceof Error ? e.message : 'Erro' }
}

async function reactivate(id: string) {
  shiftBusy.value = true; shiftMsg.value = ''
  try { await api(`/driver/shifts/${id}/reactivate`, { method: 'POST' }); await loadShift() }
  catch (e) { shiftMsg.value = e instanceof Error ? e.message : 'Erro' }
  finally { shiftBusy.value = false }
}

async function end() {
  if (!shift.value) return
  shiftBusy.value = true
  shiftMsg.value = ''
  try { await api(`/driver/shifts/${shift.value.id}/end`, { method: 'POST' }); await loadShift() }
  catch (e) { shiftMsg.value = e instanceof Error ? e.message : 'Erro' }
  finally { shiftBusy.value = false }
}

async function onEnablePush() {
  const r = await enablePush()
  if (r === 'ok') showPushButton.value = false
}

async function savePixKey() {
  savingPix.value = true
  pixMsg.value = ''
  try {
    await api('/driver/me/pix-key', { method: 'PATCH', body: JSON.stringify({ pixKey: pixKey.value || null }) })
    pixMsg.value = 'Salvo!'
  } catch (e) {
    pixMsg.value = e instanceof Error ? e.message : 'Erro'
  } finally {
    savingPix.value = false
  }
}

async function logout() {
  await auth.logout()
  await router.replace('/login')
}
</script>

<template>
  <div class="min-h-screen">
    <header class="flex items-center justify-between border-b p-3">
      <nav class="flex gap-3 text-sm">
        <RouterLink to="/" class="underline">Disponíveis</RouterLink>
        <RouterLink to="/entregas" class="underline">Minhas entregas</RouterLink>
        <RouterLink to="/financeiro" class="underline">Ganhos</RouterLink>
        <RouterLink to="/lojas" class="underline">Minhas lojas</RouterLink>
        <RouterLink to="/vagas" class="underline">Vagas</RouterLink>
        <RouterLink to="/perfil" class="underline">Meus dados</RouterLink>
      </nav>
      <div class="flex items-center gap-2">
        <button v-if="showPushButton" class="text-sm underline" @click="onEnablePush">🔔 Ativar alertas</button>
        <button
          :disabled="saving"
          class="rounded-full px-3 py-1 text-sm font-semibold"
          :class="isAvailable ? 'bg-green-600 text-white' : 'bg-gray-300'"
          @click="toggle"
        >
          {{ isAvailable ? 'Disponível' : 'Indisponível' }}
        </button>
        <button class="text-sm underline" @click="logout">Sair</button>
      </div>
    </header>
    <section class="border-b bg-blue-50 p-3 text-sm">
      <div v-if="shift" class="flex flex-wrap items-center justify-between gap-2">
        <span><strong>Turno ativo:</strong> {{ shift.storeName }} · {{ shift.storeAddressText }}</span>
        <button class="rounded bg-black px-3 py-1 text-white disabled:opacity-50" :disabled="shiftBusy" @click="end">Encerrar turno</button>
      </div>
      <div v-else-if="links.length" class="space-y-1">
        <div class="flex flex-wrap items-center gap-2">
          <span>Iniciar turno:</span>
          <button v-for="link in links" :key="link.id" class="rounded border bg-white px-3 py-1 text-left disabled:opacity-50" :disabled="shiftBusy || !canStart(link)" :title="startReason(link)" @click="start(link.id)">{{ link.storeName }} · {{ linkWindowLabel(link) }}<small class="block">{{ startReason(link) }}</small></button>
        </div>
        <p v-if="openWindow" class="font-semibold text-green-700">🟢 {{ openWindow.store }}: você está no horário ({{ openWindow.item.start }}–{{ openWindow.item.end }}) — inicie o turno.</p>
        <p v-else-if="soon" class="font-semibold text-orange-700">⏰ Falta pouco! {{ nextLabel }}</p>
        <p v-else-if="nextLabel" class="text-gray-600">Próximo turno: {{ nextLabel }}</p>
      </div>
      <p v-else>Confirme um convite em “Minhas lojas” para iniciar um turno.</p>
      <p v-if="shiftMsg" class="mt-1 text-red-600">{{ shiftMsg }}</p>
    </section>
    <section v-if="authorizations.some((item) => item.status === 'PENDING')" class="border-b bg-orange-50 p-3 text-sm">
      <p class="font-semibold">Autorizações excepcionais pendentes</p>
      <div v-for="item in authorizations.filter((entry) => entry.status === 'PENDING')" :key="item.id" class="mt-2 rounded border bg-white p-2">
        <p>Até {{ new Date(item.authorizedUntil).toLocaleString('pt-BR') }} · fim {{ new Date(item.scheduledEndAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) }}</p>
        <p>{{ formatBRL(item.dailyRateCents) }}/dia + {{ formatBRL(item.perDeliveryCents) }}/entrega · {{ item.note }}</p>
        <div class="mt-2 flex gap-2"><button class="rounded border px-3 py-1" @click="decideAuthorization(item.id, 'reject')">Recusar</button><button class="rounded bg-black px-3 py-1 text-white" @click="decideAuthorization(item.id, 'accept')">Aceitar</button></div>
      </div>
    </section>
    <section v-if="recentShifts.some((item) => item.status === 'PENDING_DAILY' || item.status === 'REOPEN_ALLOWED')" class="border-b bg-purple-50 p-3 text-sm">
      <div v-for="item in recentShifts.filter((entry) => entry.status === 'PENDING_DAILY' || entry.status === 'REOPEN_ALLOWED')" :key="item.id" class="rounded border bg-white p-2">
        <p class="font-semibold">Diária {{ item.status === 'REOPEN_ALLOWED' ? 'com reativação liberada' : 'aguardando decisão da loja' }}</p>
        <p>{{ formatBRL(item.dailyRateCents) }} · aprovação automática em até 24h.</p>
        <button v-if="item.status === 'REOPEN_ALLOWED' && new Date() <= new Date(item.reopenUntil!)" class="mt-2 rounded bg-black px-3 py-1 text-white" :disabled="shiftBusy" @click="reactivate(item.id)">Reativar turno até {{ new Date(item.reopenUntil!).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) }}</button>
        <p v-else-if="item.status === 'REOPEN_ALLOWED'" class="mt-1 text-red-700">Prazo de reativação encerrado; a diária aguarda decisão.</p>
      </div>
    </section>
    <details v-if="recentShifts.some((item) => item.status === 'CLOSED' && item.dailyDecision)" class="border-b p-3 text-sm">
      <summary class="cursor-pointer text-gray-600">Decisões recentes de diária</summary>
      <p v-for="item in recentShifts.filter((entry) => entry.status === 'CLOSED' && entry.dailyDecision).slice(0, 5)" :key="item.id" class="mt-2 rounded border p-2">
        {{ item.workDate.split('-').reverse().join('/') }} · {{ formatBRL(item.dailyRateCents) }} ·
        <strong :class="item.dailyDecision === 'APPROVED' ? 'text-green-700' : 'text-red-700'">{{ item.dailyDecision === 'APPROVED' ? 'Aprovada' : 'Recusada' }}</strong>
        <span v-if="item.dailyDecisionReason" class="block text-xs text-gray-600">{{ item.dailyDecisionReason }}</span>
      </p>
    </details>
    <section v-if="shift?.pendingTerms" class="border-b bg-yellow-50 p-3 text-sm">
      <p class="font-semibold">Proposta de reajuste do turno</p>
      <p>{{ formatBRL(shift.pendingTerms.dailyRateCents) }}/dia + {{ formatBRL(shift.pendingTerms.perDeliveryCents) }}/entrega</p>
      <p>{{ shift.pendingTerms.applyRetroactive ? 'Extra retroativo para entregas concluídas' : 'Novo extra apenas para próximas entregas' }}</p>
      <p v-if="shift.pendingTerms.note">{{ shift.pendingTerms.note }}</p>
      <div class="mt-2 flex gap-2"><button class="rounded border px-3 py-1" @click="decideShiftTerms(shift.pendingTerms!.id, 'reject')">Recusar</button><button class="rounded bg-black px-3 py-1 text-white" @click="decideShiftTerms(shift.pendingTerms!.id, 'accept')">Aceitar</button></div>
    </section>
    <details class="border-b p-3 text-sm">
      <summary class="cursor-pointer text-gray-600">Minha chave PIX (recebimento do frete)</summary>
      <div class="mt-2 flex gap-2">
        <input v-model="pixKey" placeholder="Chave PIX" class="flex-1 rounded border p-2" />
        <button class="rounded bg-black px-3 text-white" :disabled="savingPix" @click="savePixKey">Salvar</button>
      </div>
      <p v-if="pixMsg" class="mt-1 text-xs" :class="pixMsg === 'Salvo!' ? 'text-green-700' : 'text-red-600'">{{ pixMsg }}</p>
    </details>
    <RouterView />
  </div>
</template>
