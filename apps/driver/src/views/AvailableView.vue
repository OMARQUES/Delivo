<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { formatBRL } from '@delivery/shared/constants'
import { api } from '../lib/api'

type Available = {
  orderId: string
  status: string
  deliveryFeeCents: number | null
  distanceKm: number | null
  createdAt: string
  storeName: string
  storeAddressText: string
  storeLat: number
  storeLng: number
  perDeliveryCents?: number
  driverRequestTarget?: 'OWN' | 'SPECIFIC'
  requestedDriverId?: string | null
}

type AvailableBatch = {
  batchId: string
  count: number
  feeTotalCents: number
  storeName: string
  storeAddressText: string
  target?: 'GENERAL' | 'OWN' | 'SPECIFIC'
  direct?: boolean
  estimatedExtraCents?: number
}

const router = useRouter()
const list = ref<Available[]>([])
const batches = ref<AvailableBatch[]>([])
const error = ref('')
const accepting = ref('')
const available = ref(true)
const inShift = ref(false)
let timer: ReturnType<typeof setInterval> | undefined
let known = new Set<string>()
let firstLoad = true

function beep() {
  try {
    const ctx = new AudioContext()
    const osc = ctx.createOscillator()
    osc.type = 'square'
    osc.frequency.value = 660
    osc.connect(ctx.destination)
    osc.start()
    setTimeout(() => {
      osc.stop()
      ctx.close()
    }, 500)
  } catch {
    // Sem permissao de audio.
  }
}

async function load() {
  try {
    const me = await api<{ isAvailable: boolean }>('/driver/me')
    available.value = me.isAvailable
    const shift = await api<{ id: string } | null>('/driver/shifts/active')
    inShift.value = Boolean(shift)
    const [rows, packageRows] = await Promise.all([
      api<Available[]>(shift ? '/driver/shift-deliveries' : '/driver/available'),
      api<AvailableBatch[]>(shift ? '/driver/shift-batches' : '/driver/batches'),
    ])
    const ids = new Set([...rows.map((r) => `order:${r.orderId}`), ...packageRows.map((b) => `batch:${b.batchId}`)])
    if (available.value && !firstLoad && [...ids].some((id) => !known.has(id))) beep()
    known = ids
    firstLoad = false
    list.value = rows
    batches.value = packageRows
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Erro'
  }
}

onMounted(() => {
  load()
  timer = setInterval(load, 1_000)
})
onBeforeUnmount(() => clearInterval(timer))

async function accept(o: Available) {
  accepting.value = o.orderId
  error.value = ''
  try {
    await api(`/driver/orders/${o.orderId}/${inShift.value ? 'accept-shift' : 'accept'}`, { method: 'POST' })
    await router.push('/entregas')
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Erro'
    await load()
  } finally {
    accepting.value = ''
  }
}

async function acceptBatch(batch: AvailableBatch) {
  accepting.value = batch.batchId
  error.value = ''
  try {
    await api(`/driver/batches/${batch.batchId}/accept`, { method: 'POST' })
    await router.push('/entregas')
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Erro'
    await load()
  } finally {
    accepting.value = ''
  }
}

async function refuseOrder(orderId: string) {
  try { await api(`/driver/orders/${orderId}/refuse-direct`, { method: 'POST' }); await load() }
  catch (e) { error.value = e instanceof Error ? e.message : 'Erro' }
}

async function refuseTargetBatch(batchId: string) {
  try { await api(`/driver/batches/${batchId}/refuse`, { method: 'POST' }); await load() }
  catch (e) { error.value = e instanceof Error ? e.message : 'Erro' }
}
</script>

<template>
  <main class="mx-auto max-w-lg p-4">
    <h1 class="text-xl font-bold">Entregas disponíveis</h1>
    <p v-if="inShift" class="mt-1 text-sm text-blue-700">Mostrando somente pedidos da loja do turno.</p>
    <p v-if="!available" class="mt-2 rounded bg-yellow-100 p-2 text-sm text-yellow-800">
      Você está indisponível — ative no topo para receber entregas
    </p>
    <p v-if="error" class="mt-1 text-sm text-red-600">{{ error }}</p>
    <p v-if="list.length === 0 && batches.length === 0" class="mt-4 text-gray-500">Nenhuma entrega no momento. Avisamos quando pintar!</p>
    <ul class="mt-3 space-y-2">
      <li v-for="batch in batches" :key="batch.batchId" class="rounded border border-blue-300 bg-blue-50 p-3">
        <div class="flex items-center justify-between">
          <div>
            <p class="font-semibold">📦 Pacote — {{ batch.count }} entregas</p>
            <p v-if="batch.direct" class="text-xs font-semibold text-blue-700">📍 Direcionado a você</p>
            <p class="text-xs text-gray-500">{{ batch.storeName }} · coleta: {{ batch.storeAddressText }}</p>
          </div>
          <div class="text-right">
            <p class="font-bold">{{ formatBRL(inShift ? (batch.estimatedExtraCents ?? 0) : batch.feeTotalCents) }}</p>
            <p class="text-xs text-gray-500">{{ inShift ? 'extra estimado' : 'frete total' }}</p>
          </div>
        </div>
        <button
          :disabled="accepting === batch.batchId"
          class="mt-2 w-full rounded bg-black p-2 font-semibold text-white disabled:opacity-50"
          @click="acceptBatch(batch)"
        >{{ accepting === batch.batchId ? 'Aceitando...' : 'Aceitar pacote' }}</button>
        <button v-if="batch.direct" class="mt-2 w-full rounded border border-red-400 p-2 text-red-600" @click="refuseTargetBatch(batch.batchId)">Recusar pacote</button>
      </li>
    </ul>
    <ul class="mt-3 space-y-2">
      <li v-for="o in list" :key="o.orderId" class="rounded border p-3">
        <div class="flex items-center justify-between">
          <div>
            <p class="font-semibold">{{ o.storeName }}</p>
            <p v-if="o.driverRequestTarget === 'SPECIFIC'" class="text-xs font-semibold text-blue-700">📍 Direcionado a você</p>
            <p class="text-xs text-gray-500">Coleta: {{ o.storeAddressText }}</p>
            <p class="text-xs text-gray-400">Endereço de entrega liberado após aceitar</p>
            <p v-if="o.distanceKm" class="text-xs text-gray-500">~{{ o.distanceKm.toFixed(1) }} km até o cliente</p>
          </div>
          <div class="text-right">
            <p class="font-bold">{{ formatBRL(inShift ? (o.perDeliveryCents ?? 0) : (o.deliveryFeeCents ?? 0)) }}</p>
            <p class="text-xs text-gray-500">{{ inShift ? 'extra' : 'frete' }}</p>
          </div>
        </div>
        <button
          :disabled="accepting === o.orderId"
          class="mt-2 w-full rounded bg-black p-2 font-semibold text-white disabled:opacity-50"
          @click="accept(o)"
        >
          {{ accepting === o.orderId ? 'Aceitando...' : 'Aceitar entrega' }}
        </button>
        <button v-if="o.driverRequestTarget === 'SPECIFIC'" class="mt-2 w-full rounded border border-red-400 p-2 text-red-600" @click="refuseOrder(o.orderId)">Recusar</button>
      </li>
    </ul>
  </main>
</template>
