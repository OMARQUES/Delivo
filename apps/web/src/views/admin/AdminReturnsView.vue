<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { formatBRL } from '@delivery/shared/constants'
import { api } from '../../lib/api'

type PendingReturn = {
  id: string
  storeName: string
  driverName: string
  driverPhone: string | null
  returnPendingAgeMinutes: number
  returnDriverPayCents: number | null
  failReason: string | null
}
const rows = ref<PendingReturn[]>([])
const error = ref('')
async function load() {
  try { rows.value = await api<PendingReturn[]>('/admin/returns') }
  catch (e) { error.value = e instanceof Error ? e.message : 'Erro' }
}
function age(minutes: number) { return minutes < 60 ? `${minutes}min` : `${Math.floor(minutes / 60)}h ${minutes % 60}min` }
async function confirmReturn(row: PendingReturn) {
  if (!confirm(`Confirmar manualmente a devolução de ${row.driverName}?`)) return
  try { await api(`/admin/orders/${row.id}/confirm-return`, { method: 'POST' }); await load() }
  catch (e) { error.value = e instanceof Error ? e.message : 'Erro' }
}
onMounted(load)
</script>

<template>
  <main class="mx-auto max-w-4xl p-4">
    <h1 class="text-xl font-bold">Devoluções pendentes</h1>
    <p class="text-sm text-gray-500">Confirmação manual de suporte; não há baixa automática.</p>
    <p v-if="error" class="mt-2 text-sm text-red-600">{{ error }}</p>
    <p v-if="!rows.length" class="mt-4 text-gray-500">Nenhuma devolução pendente.</p>
    <ul class="mt-4 space-y-2">
      <li v-for="row in rows" :key="row.id" class="flex flex-wrap items-center justify-between gap-3 rounded border border-yellow-400 bg-yellow-50 p-3 text-sm">
        <span><strong>{{ row.storeName }}</strong> · {{ row.driverName }}<br><span class="text-gray-600">Pendente há {{ age(row.returnPendingAgeMinutes) }} · pagamento {{ formatBRL(row.returnDriverPayCents ?? 0) }} · {{ row.failReason }}</span></span>
        <button class="rounded bg-black px-3 py-2 text-white" @click="confirmReturn(row)">Confirmar devolução</button>
      </li>
    </ul>
  </main>
</template>
