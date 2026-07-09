<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { formatBRL, ORDER_STATUS_LABELS, type OrderStatus } from '@delivery/shared/constants'
import { api } from '../lib/api'

type Order = { id: string; status: OrderStatus; totalCents: number; createdAt: string; fulfillment: string }
const orders = ref<Order[]>([])
const loading = ref(true)

onMounted(async () => {
  try {
    orders.value = await api<Order[]>('/orders')
  } finally {
    loading.value = false
  }
})

const dt = (iso: string) =>
  new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
</script>

<template>
  <main class="mx-auto max-w-lg p-4">
    <h1 class="text-xl font-bold">Meus pedidos</h1>
    <p v-if="loading" class="mt-4 text-gray-500">Carregando…</p>
    <p v-else-if="orders.length === 0" class="mt-4 text-gray-500">
      Nenhum pedido ainda. <RouterLink to="/" class="underline">Ver lojas</RouterLink>
    </p>
    <ul class="mt-4 space-y-2">
      <li v-for="o in orders" :key="o.id">
        <RouterLink :to="`/pedido/${o.id}`" class="flex items-center justify-between rounded border p-3">
          <span>
            <span class="font-medium">{{ ORDER_STATUS_LABELS[o.status] }}</span>
            <span class="block text-xs text-gray-500">
              {{ dt(o.createdAt) }} · {{ o.fulfillment === 'PICKUP' ? 'Retirada' : 'Entrega' }}
            </span>
          </span>
          <span class="font-semibold">{{ formatBRL(o.totalCents) }}</span>
        </RouterLink>
      </li>
    </ul>
  </main>
</template>
