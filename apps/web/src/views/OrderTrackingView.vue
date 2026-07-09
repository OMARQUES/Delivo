<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import { formatBRL, ORDER_STATUS_LABELS, type OrderStatus } from '@delivery/shared/constants'
import { api } from '../lib/api'

type Item = {
  id: string
  nameSnapshot: string
  quantity: number
  totalCents: number
  note: string | null
  options: { label: string }[]
}
type Order = {
  id: string
  status: OrderStatus
  fulfillment: 'DELIVERY' | 'PICKUP'
  subtotalCents: number
  deliveryFeeCents: number | null
  totalCents: number
  addressText: string | null
  cancelReason: string | null
  cancelRequestedAt: string | null
  createdAt: string
  items: Item[]
  storeName: string
  storePhone: string | null
  storeSlug: string
  driverName: string | null
  events: { status: OrderStatus; createdAt: string; note: string | null }[]
}

const route = useRoute()
const order = ref<Order | null>(null)
const error = ref('')
let timer: ReturnType<typeof setInterval> | undefined

const STEPS: OrderStatus[] = ['PENDING', 'ACCEPTED', 'PREPARING', 'READY', 'OUT_FOR_DELIVERY', 'DELIVERED']

async function load() {
  try {
    order.value = await api<Order>(`/orders/${route.params.orderId as string}`)
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Erro'
  }
}

onMounted(() => {
  load()
  timer = setInterval(load, 20_000)
})
onBeforeUnmount(() => clearInterval(timer))

const stepIndex = computed(() => (order.value ? STEPS.indexOf(order.value.status) : -1))
const isFinal = computed(() => order.value && ['DELIVERED', 'CANCELLED', 'DELIVERY_FAILED'].includes(order.value.status))

async function cancel() {
  if (!order.value || !confirm('Cancelar este pedido?')) return
  try {
    await api(`/orders/${order.value.id}/cancel`, { method: 'POST' })
    await load()
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Erro'
  }
}

async function requestCancel() {
  if (!order.value) return
  const note = prompt('Motivo (opcional):') ?? undefined
  try {
    await api(`/orders/${order.value.id}/cancel-request`, { method: 'POST', body: JSON.stringify({ note }) })
    await load()
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Erro'
  }
}
</script>

<template>
  <main class="mx-auto max-w-lg space-y-4 p-4">
    <p v-if="error" class="text-red-600">{{ error }}</p>
    <template v-if="order">
      <h1 class="text-xl font-bold">Pedido — {{ order.storeName }}</h1>
      <a
        v-if="order.storePhone"
        :href="`https://wa.me/55${order.storePhone}`"
        target="_blank"
        class="inline-block rounded border px-2 py-1 text-sm underline"
      >WhatsApp da loja</a>

      <section v-if="order.status === 'CANCELLED'" class="rounded border border-red-300 bg-red-50 p-3">
        Cancelado{{ order.cancelReason ? ` — ${order.cancelReason}` : '' }}
      </section>
      <section v-else-if="order.status === 'DELIVERY_FAILED'" class="rounded border border-red-300 bg-red-50 p-3">
        Entrega não realizada. Entre em contato com a loja.
      </section>
      <ol v-else class="space-y-1">
        <li
          v-for="(s, i) in STEPS"
          :key="s"
          class="flex items-center gap-2 text-sm"
          :class="i <= stepIndex ? 'font-semibold' : 'text-gray-400'"
        >
          <span class="h-2 w-2 rounded-full" :class="i <= stepIndex ? 'bg-green-600' : 'bg-gray-300'"></span>
          {{ ORDER_STATUS_LABELS[s] }}
        </li>
      </ol>

      <p v-if="order.driverName && !isFinal" class="rounded border border-blue-200 bg-blue-50 p-2 text-sm">
        🛵 {{ order.driverName }} é seu entregador
      </p>

      <p v-if="order.cancelRequestedAt && order.status !== 'CANCELLED'" class="rounded border border-yellow-300 bg-yellow-50 p-2 text-sm">
        Cancelamento solicitado — aguardando a loja.
      </p>

      <section class="rounded border p-3 text-sm">
        <ul class="space-y-1">
          <li v-for="i in order.items" :key="i.id">
            {{ i.quantity }}× {{ i.nameSnapshot }}
            <span class="text-gray-500">{{ i.options.map((o) => o.label).join(', ') }}</span>
            <span class="float-right">{{ formatBRL(i.totalCents) }}</span>
          </li>
        </ul>
        <hr class="my-2" />
        <p class="flex justify-between"><span>Subtotal</span><span>{{ formatBRL(order.subtotalCents) }}</span></p>
        <p v-if="order.deliveryFeeCents != null" class="flex justify-between"><span>Entrega</span><span>{{ formatBRL(order.deliveryFeeCents) }}</span></p>
        <p class="flex justify-between font-bold"><span>Total</span><span>{{ formatBRL(order.totalCents) }}</span></p>
        <p v-if="order.addressText" class="mt-1 text-gray-500">Entregar em: {{ order.addressText }}</p>
      </section>

      <div v-if="!isFinal" class="flex gap-2">
        <button v-if="order.status === 'PENDING'" class="flex-1 rounded border border-red-400 p-2 text-red-600" @click="cancel">
          Cancelar pedido
        </button>
        <button
          v-else-if="!order.cancelRequestedAt && order.status !== 'OUT_FOR_DELIVERY'"
          class="flex-1 rounded border p-2"
          @click="requestCancel"
        >
          Solicitar cancelamento
        </button>
      </div>
      <RouterLink to="/pedidos" class="block text-center text-sm underline">Meus pedidos</RouterLink>
    </template>
  </main>
</template>
