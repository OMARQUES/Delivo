<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import {
  DELIVERY_FAIL_REASONS,
  DELIVERY_FAIL_REASON_LABELS,
  formatBRL,
  isPaidOnline,
  ORDER_STATUS_LABELS,
  type DeliveryFailReason,
  type OrderStatus,
  type PaymentMethod,
} from '@delivery/shared/constants'
import { api } from '../lib/api'

type Delivery = {
  id: string
  status: OrderStatus
  paymentMethod: PaymentMethod
  changeForCents: number | null
  totalCents: number
  deliveryFeeCents: number | null
  addressText: string | null
  addressReference: string | null
  addressLat: number | null
  addressLng: number | null
  storeName: string
  storeAddressText: string
  storeLat: number
  storeLng: number
  storePhone: string
  customerName: string
  customerPhone: string | null
  note: string | null
  createdAt: string
  batchId: string | null
  driverArrivedAt: string | null
  returnPendingAt: string | null
  returnedAt: string | null
  driverReturnedAt: string | null
  returnPhotoKeys: string[]
}

const active = ref<Delivery[]>([])
const doneList = ref<Delivery[]>([])
const returnList = ref<Delivery[]>([])
const error = ref('')
const failFor = ref<Delivery | null>(null)
const failReason = ref<DeliveryFailReason>('NO_ANSWER')
const failNote = ref('')
const uploadingReturnFor = ref<string | null>(null)
let timer: ReturnType<typeof setInterval> | undefined
const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:8787'

async function load() {
  try {
    const [a, d, returns] = await Promise.all([
      api<Delivery[]>('/driver/deliveries?scope=active'),
      api<Delivery[]>('/driver/deliveries?scope=done'),
      api<Delivery[]>('/driver/deliveries?scope=returns'),
    ])
    active.value = a
    doneList.value = d
    returnList.value = returns
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Erro'
  }
}

onMounted(() => {
  load()
  timer = setInterval(load, 1_000)
})
onBeforeUnmount(() => clearInterval(timer))

async function act(o: Delivery, action: 'collect' | 'deliver' | 'release') {
  error.value = ''
  try {
    await api(`/driver/orders/${o.id}/${action}`, { method: 'POST' })
    await load()
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Erro'
  }
}

async function arrive(o: Delivery) {
  error.value = ''
  let body: { lat?: number; lng?: number } = {}
  try {
    const position = await new Promise<GeolocationPosition>((resolve, reject) =>
      navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, timeout: 8_000 }),
    )
    body = { lat: position.coords.latitude, lng: position.coords.longitude }
  } catch {
    // GPS best-effort: a chegada ainda pode ser registrada sem coordenadas.
  }
  try {
    await api(`/driver/orders/${o.id}/arrived`, { method: 'POST', body: JSON.stringify(body) })
    await load()
  } catch (e) { error.value = e instanceof Error ? e.message : 'Erro' }
}

async function actBatch(batchId: string, action: 'collect' | 'release') {
  error.value = ''
  try {
    await api(`/driver/batches/${batchId}/${action}`, { method: 'POST' })
    await load()
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Erro'
  }
}

async function submitFail() {
  if (!failFor.value) return
  try {
    await api(`/driver/orders/${failFor.value.id}/fail`, {
      method: 'POST',
      body: JSON.stringify({ reason: failReason.value, note: failNote.value || undefined }),
    })
    failFor.value = null
    failNote.value = ''
    await load()
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Erro'
  }
}

async function markReturned(o: Delivery) {
  error.value = ''
  try {
    await api(`/driver/orders/${o.id}/returned`, { method: 'POST' })
    await load()
  } catch (e) { error.value = e instanceof Error ? e.message : 'Erro' }
}

async function uploadReturnPhoto(o: Delivery, event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  error.value = ''
  uploadingReturnFor.value = o.id
  try {
    await api(`/driver/orders/${o.id}/return-photo`, {
      method: 'PUT',
      headers: { 'Content-Type': file.type },
      body: file,
    })
    await load()
  } catch (e) { error.value = e instanceof Error ? e.message : 'Erro' }
  finally { uploadingReturnFor.value = null }
}

const waze = (lat: number, lng: number) => `https://waze.com/ul?ll=${lat},${lng}&navigate=yes`
const wa = (phone: string | null) => (phone ? `https://wa.me/55${phone}` : null)
const collectible = (o: Delivery) => o.status === 'READY' || o.status === 'AWAITING_DRIVER'
const inRoute = (o: Delivery) => o.status === 'OUT_FOR_DELIVERY'
const waiting = (o: Delivery) => !collectible(o) && !inRoute(o)

function paymentLine(o: Delivery) {
  if (isPaidOnline(o.paymentMethod)) return `Pago online - não cobrar (total ${formatBRL(o.totalCents)})`
  const how = o.paymentMethod === 'CASH'
    ? `dinheiro${o.changeForCents ? `, troco p/ ${formatBRL(o.changeForCents)}` : ''}`
    : 'maquininha'
  return `Receber: ${formatBRL(o.totalCents)} (${how})`
}

const batchPickups = computed(() => {
  const grouped = new Map<string, Delivery[]>()
  for (const delivery of active.value) {
    if (!inRoute(delivery) && delivery.batchId) {
      const group = grouped.get(delivery.batchId) ?? []
      group.push(delivery)
      grouped.set(delivery.batchId, group)
    }
  }
  return [...grouped.entries()].map(([batchId, deliveries]) => ({
    batchId,
    deliveries,
    storeName: deliveries[0]!.storeName,
    storeAddressText: deliveries[0]!.storeAddressText,
    ready: deliveries.every((delivery) => delivery.status === 'READY'),
  }))
})
const toCollect = computed(() => active.value.filter((o) => !inRoute(o) && !o.batchId))
const toDeliver = computed(() => active.value.filter(inRoute))
const pendingReturns = computed(() => returnList.value)
const history = computed(() => doneList.value.filter((o) => !pendingReturns.value.some((pending) => pending.id === o.id)))
const mediaUrl = (key: string) => `${API_URL}/media/${key}`
</script>

<template>
  <main class="mx-auto max-w-lg space-y-4 p-4">
    <p v-if="error" class="text-sm text-red-600">{{ error }}</p>

    <section v-if="pendingReturns.length" class="rounded border border-yellow-500 bg-yellow-50 p-3">
      <h2 class="font-bold">📦 Devolver na loja ({{ pendingReturns.length }})</h2>
      <p class="text-xs text-yellow-800">O pagamento é liberado após a loja confirmar o recebimento.</p>
      <ul class="mt-2 space-y-2">
        <li v-for="o in pendingReturns" :key="o.id" class="rounded border border-yellow-300 bg-white p-3">
          <p class="font-semibold">{{ o.storeName }}</p>
          <p class="text-xs text-gray-500">{{ o.storeAddressText }}</p>
          <div v-if="o.returnPhotoKeys.length" class="mt-2 flex gap-2">
            <a v-for="key in o.returnPhotoKeys" :key="key" :href="mediaUrl(key)" target="_blank">
              <img :src="mediaUrl(key)" alt="Comprovante da devolução" class="h-20 w-20 rounded border object-cover" />
            </a>
          </div>
          <p v-if="o.driverReturnedAt" class="mt-2 rounded bg-blue-50 p-2 text-xs text-blue-800">
            ✓ Devolução informada — aguardando a loja confirmar.
          </p>
          <div class="mt-2 flex flex-wrap gap-2 text-sm">
            <a :href="waze(o.storeLat, o.storeLng)" target="_blank" class="rounded border px-2 py-1 underline">Waze loja</a>
            <button v-if="!o.driverReturnedAt" class="rounded bg-black px-2 py-1 text-white" @click="markReturned(o)">Devolvi na loja</button>
            <label v-if="o.returnPhotoKeys.length < 2" class="cursor-pointer rounded border px-2 py-1" :class="uploadingReturnFor === o.id && 'opacity-50'">
              {{ uploadingReturnFor === o.id ? 'Enviando…' : '📷 Anexar foto' }}
              <input class="hidden" type="file" accept="image/jpeg,image/png,image/webp" capture="environment" :disabled="uploadingReturnFor === o.id" @change="uploadReturnPhoto(o, $event)" />
            </label>
            <span v-else class="rounded bg-gray-100 px-2 py-1 text-xs">2 fotos anexadas</span>
          </div>
        </li>
      </ul>
    </section>

    <section>
      <h2 class="font-bold">Coletar na loja ({{ toCollect.length }} avulsa(s), {{ batchPickups.length }} pacote(s))</h2>
      <ul class="mt-2 space-y-2">
        <li v-for="batch in batchPickups" :key="batch.batchId" class="rounded border border-blue-300 bg-blue-50 p-3">
          <p class="font-semibold">📦 Pacote — {{ batch.deliveries.length }} entregas</p>
          <p class="text-xs text-gray-500">{{ batch.storeName }} · coleta: {{ batch.storeAddressText }}</p>
          <p class="text-xs text-gray-500">
            {{ batch.ready ? 'Todos os pedidos estão prontos.' : 'Aguardando todos os pedidos ficarem prontos.' }}
          </p>
          <div class="mt-2 flex flex-wrap gap-2 text-sm">
            <a :href="waze(batch.deliveries[0]!.storeLat, batch.deliveries[0]!.storeLng)" target="_blank" class="rounded border px-2 py-1 underline">Waze loja</a>
            <a :href="`https://wa.me/55${batch.deliveries[0]!.storePhone}`" target="_blank" class="rounded border px-2 py-1 underline">WhatsApp loja</a>
            <button
              :disabled="!batch.ready"
              class="rounded bg-black px-2 py-1 text-white disabled:opacity-40"
              @click="actBatch(batch.batchId, 'collect')"
            >Coletei tudo</button>
            <button class="rounded border border-red-400 px-2 py-1 text-red-600" @click="actBatch(batch.batchId, 'release')">Liberar pacote</button>
          </div>
        </li>
        <li v-for="o in toCollect" :key="o.id" class="rounded border p-3">
          <p class="font-semibold">{{ o.storeName }}</p>
          <p class="text-xs text-gray-500">Coleta: {{ o.storeAddressText }} · {{ ORDER_STATUS_LABELS[o.status] }}</p>
          <p v-if="o.addressText" class="text-xs text-gray-500">
            Entrega: {{ o.addressText }}<template v-if="o.addressReference"> · {{ o.addressReference }}</template>
          </p>
          <p class="text-xs" :class="isPaidOnline(o.paymentMethod) ? 'font-semibold text-green-700' : ''">{{ paymentLine(o) }}</p>
          <div class="mt-2 flex flex-wrap gap-2 text-sm">
            <a :href="waze(o.storeLat, o.storeLng)" target="_blank" class="rounded border px-2 py-1 underline">Waze loja</a>
            <a :href="`https://wa.me/55${o.storePhone}`" target="_blank" class="rounded border px-2 py-1 underline">WhatsApp loja</a>
            <button v-if="!o.driverArrivedAt" class="rounded border border-blue-500 px-2 py-1 text-blue-700" @click="arrive(o)">📍 Cheguei na loja</button>
            <span v-else class="rounded bg-blue-100 px-2 py-1 text-xs">📍 chegada registrada</span>
            <button v-if="collectible(o)" class="rounded bg-black px-2 py-1 text-white" @click="act(o, 'collect')">Coletei</button>
            <span v-else-if="waiting(o)" class="rounded bg-yellow-100 px-2 py-1 text-xs">aguardando ficar pronto...</span>
            <button class="rounded border border-red-400 px-2 py-1 text-red-600" @click="act(o, 'release')">Liberar</button>
          </div>
        </li>
      </ul>
      <p v-if="toCollect.length === 0" class="mt-1 text-sm text-gray-500">Nada pra coletar.</p>
    </section>

    <section>
      <h2 class="font-bold">Entregar ({{ toDeliver.length }})</h2>
      <ul class="mt-2 space-y-2">
        <li v-for="o in toDeliver" :key="o.id" class="rounded border border-green-500 p-3">
          <p class="font-semibold">{{ o.customerName }}</p>
          <p class="text-xs text-gray-500">
            Entrega: {{ o.addressText }}<template v-if="o.addressReference"> · {{ o.addressReference }}</template>
          </p>
          <p class="text-xs" :class="isPaidOnline(o.paymentMethod) ? 'font-semibold text-green-700' : ''">{{ paymentLine(o) }}</p>
          <p v-if="o.note" class="text-xs italic">Obs: {{ o.note }}</p>
          <div class="mt-2 flex flex-wrap gap-2 text-sm">
            <a v-if="o.addressLat && o.addressLng" :href="waze(o.addressLat, o.addressLng)" target="_blank" class="rounded border px-2 py-1 underline">Waze cliente</a>
            <a v-if="wa(o.customerPhone)" :href="wa(o.customerPhone)!" target="_blank" class="rounded border px-2 py-1 underline">WhatsApp cliente</a>
            <button class="rounded bg-green-600 px-2 py-1 text-white" @click="act(o, 'deliver')">Entreguei</button>
            <button class="rounded border border-red-400 px-2 py-1 text-red-600" @click="failFor = o">Não consegui</button>
          </div>
        </li>
      </ul>
      <p v-if="toDeliver.length === 0" class="mt-1 text-sm text-gray-500">Nada em rota.</p>
    </section>

    <details>
      <summary class="cursor-pointer font-semibold">Histórico ({{ history.length }})</summary>
      <ul class="mt-2 space-y-1 text-sm">
        <li v-for="o in history" :key="o.id" class="flex justify-between gap-2 rounded border p-2">
          <span>{{ o.storeName }} -> {{ o.customerName }} · {{ ORDER_STATUS_LABELS[o.status] }}<span v-if="o.returnedAt" class="mt-1 block text-xs text-green-700">Devolução confirmada · pagamento liberado</span></span>
          <span>{{ o.deliveryFeeCents != null ? formatBRL(o.deliveryFeeCents) : '-' }}</span>
        </li>
      </ul>
    </details>

    <div v-if="failFor" class="fixed inset-0 z-10 flex items-center justify-center bg-black/40" @click.self="failFor = null">
      <div class="w-full max-w-sm rounded bg-white p-4">
        <h3 class="font-bold">Não consegui entregar</h3>
        <select v-model="failReason" class="mt-2 w-full rounded border p-2">
          <option v-for="r in DELIVERY_FAIL_REASONS" :key="r" :value="r">{{ DELIVERY_FAIL_REASON_LABELS[r] }}</option>
        </select>
        <textarea v-model="failNote" placeholder="Detalhe (opcional)" class="mt-2 w-full rounded border p-2"></textarea>
        <p class="mt-1 text-xs text-gray-500">O produto deve voltar pra loja.</p>
        <div class="mt-3 flex gap-2">
          <button class="flex-1 rounded border p-2" @click="failFor = null">Voltar</button>
          <button class="flex-1 rounded bg-red-600 p-2 text-white" @click="submitFail">Confirmar falha</button>
        </div>
      </div>
    </div>
  </main>
</template>
