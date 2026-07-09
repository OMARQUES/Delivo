<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import {
  DELIVERY_FAIL_REASONS,
  DELIVERY_FAIL_REASON_LABELS,
  formatBRL,
  ORDER_STATUS_LABELS,
  type DeliveryFailReason,
  type OrderStatus,
} from '@delivery/shared/constants'
import { api } from '../lib/api'

type Delivery = {
  id: string
  status: OrderStatus
  paymentMethod: 'CASH' | 'CARD_MACHINE' | 'PIX_ONLINE'
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
}

const active = ref<Delivery[]>([])
const doneList = ref<Delivery[]>([])
const error = ref('')
const failFor = ref<Delivery | null>(null)
const failReason = ref<DeliveryFailReason>('NO_ANSWER')
const failNote = ref('')
let timer: ReturnType<typeof setInterval> | undefined

async function load() {
  try {
    const [a, d] = await Promise.all([
      api<Delivery[]>('/driver/deliveries?scope=active'),
      api<Delivery[]>('/driver/deliveries?scope=done'),
    ])
    active.value = a
    doneList.value = d
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Erro'
  }
}

onMounted(() => {
  load()
  timer = setInterval(load, 15_000)
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

const waze = (lat: number, lng: number) => `https://waze.com/ul?ll=${lat},${lng}&navigate=yes`
const wa = (phone: string | null) => (phone ? `https://wa.me/55${phone}` : null)
const collectible = (o: Delivery) => o.status === 'READY' || o.status === 'AWAITING_DRIVER'
const inRoute = (o: Delivery) => o.status === 'OUT_FOR_DELIVERY'
const waiting = (o: Delivery) => !collectible(o) && !inRoute(o)

const toCollect = computed(() => active.value.filter((o) => !inRoute(o)))
const toDeliver = computed(() => active.value.filter(inRoute))
</script>

<template>
  <main class="mx-auto max-w-lg space-y-4 p-4">
    <p v-if="error" class="text-sm text-red-600">{{ error }}</p>

    <section>
      <h2 class="font-bold">Coletar na loja ({{ toCollect.length }})</h2>
      <ul class="mt-2 space-y-2">
        <li v-for="o in toCollect" :key="o.id" class="rounded border p-3">
          <p class="font-semibold">{{ o.storeName }}</p>
          <p class="text-xs text-gray-500">{{ o.storeAddressText }} · {{ ORDER_STATUS_LABELS[o.status] }}</p>
          <p class="text-xs">
            Receber: <strong>{{ formatBRL(o.totalCents) }}</strong>
            ({{ o.paymentMethod === 'CASH' ? `dinheiro${o.changeForCents ? `, troco p/ ${formatBRL(o.changeForCents)}` : ''}` : 'maquininha' }})
          </p>
          <div class="mt-2 flex flex-wrap gap-2 text-sm">
            <a :href="waze(o.storeLat, o.storeLng)" target="_blank" class="rounded border px-2 py-1 underline">Waze loja</a>
            <a :href="`https://wa.me/55${o.storePhone}`" target="_blank" class="rounded border px-2 py-1 underline">WhatsApp loja</a>
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
            {{ o.addressText }}<template v-if="o.addressReference"> · {{ o.addressReference }}</template>
          </p>
          <p class="text-xs">
            Receber: <strong>{{ formatBRL(o.totalCents) }}</strong>
            ({{ o.paymentMethod === 'CASH' ? `dinheiro${o.changeForCents ? `, troco p/ ${formatBRL(o.changeForCents)}` : ''}` : 'maquininha' }})
          </p>
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
      <summary class="cursor-pointer font-semibold">Histórico ({{ doneList.length }})</summary>
      <ul class="mt-2 space-y-1 text-sm">
        <li v-for="o in doneList" :key="o.id" class="flex justify-between rounded border p-2">
          <span>{{ o.storeName }} -> {{ o.customerName }} · {{ ORDER_STATUS_LABELS[o.status] }}</span>
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
