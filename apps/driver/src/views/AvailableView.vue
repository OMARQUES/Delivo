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
}

const router = useRouter()
const list = ref<Available[]>([])
const error = ref('')
const accepting = ref('')
const available = ref(true)
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
    const rows = await api<Available[]>('/driver/available')
    const ids = new Set(rows.map((r) => r.orderId))
    if (available.value && !firstLoad && [...ids].some((id) => !known.has(id))) beep()
    known = ids
    firstLoad = false
    list.value = rows
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Erro'
  }
}

onMounted(() => {
  load()
  timer = setInterval(load, 10_000)
})
onBeforeUnmount(() => clearInterval(timer))

async function accept(o: Available) {
  accepting.value = o.orderId
  error.value = ''
  try {
    await api(`/driver/orders/${o.orderId}/accept`, { method: 'POST' })
    await router.push('/entregas')
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Erro'
    await load()
  } finally {
    accepting.value = ''
  }
}
</script>

<template>
  <main class="mx-auto max-w-lg p-4">
    <h1 class="text-xl font-bold">Entregas disponíveis</h1>
    <p v-if="!available" class="mt-2 rounded bg-yellow-100 p-2 text-sm text-yellow-800">
      Você está indisponível — ative no topo para receber entregas
    </p>
    <p v-if="error" class="mt-1 text-sm text-red-600">{{ error }}</p>
    <p v-if="list.length === 0" class="mt-4 text-gray-500">Nenhuma entrega no momento. Avisamos quando pintar!</p>
    <ul class="mt-3 space-y-2">
      <li v-for="o in list" :key="o.orderId" class="rounded border p-3">
        <div class="flex items-center justify-between">
          <div>
            <p class="font-semibold">{{ o.storeName }}</p>
            <p class="text-xs text-gray-500">{{ o.storeAddressText }}</p>
            <p v-if="o.distanceKm" class="text-xs text-gray-500">~{{ o.distanceKm.toFixed(1) }} km até o cliente</p>
          </div>
          <div class="text-right">
            <p class="font-bold">{{ o.deliveryFeeCents != null ? formatBRL(o.deliveryFeeCents) : '-' }}</p>
            <p class="text-xs text-gray-500">frete</p>
          </div>
        </div>
        <button
          :disabled="accepting === o.orderId"
          class="mt-2 w-full rounded bg-black p-2 font-semibold text-white disabled:opacity-50"
          @click="accept(o)"
        >
          {{ accepting === o.orderId ? 'Aceitando...' : 'Aceitar entrega' }}
        </button>
      </li>
    </ul>
  </main>
</template>
