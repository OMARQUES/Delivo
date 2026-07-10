<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { FINANCE_DOCUMENT_STATUS_LABELS, formatBRL, type FinanceDocumentStatus } from '@delivery/shared/constants'
import { api } from '../../lib/api'

type StoreDoc = {
  id: string
  storeName: string
  periodStart: string
  periodEnd: string
  status: FinanceDocumentStatus
  totalCents: number
  paidAt: string | null
}
type DriverDoc = {
  id: string
  driverName: string
  periodStart: string
  periodEnd: string
  status: FinanceDocumentStatus
  totalCents: number
  paidAt: string | null
}
type Finance = {
  storeInvoices: StoreDoc[]
  storePayouts: StoreDoc[]
  driverPayouts: DriverDoc[]
}

const data = ref<Finance>({ storeInvoices: [], storePayouts: [], driverPayouts: [] })
const error = ref('')
const closing = ref(false)
const today = new Date()
const lastWeek = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
const periodStart = ref(lastWeek.toISOString().slice(0, 10))
const periodEnd = ref(today.toISOString().slice(0, 10))

async function load() {
  data.value = await api<Finance>('/admin/finance')
}
onMounted(() => load().catch((e) => (error.value = e instanceof Error ? e.message : 'Erro')))

function dateToIso(value: string, addDays = 0) {
  const [year, month, day] = value.split('-').map(Number) as [number, number, number]
  return new Date(Date.UTC(year, month - 1, day + addDays)).toISOString()
}

function period(doc: StoreDoc | DriverDoc) {
  return `${new Date(doc.periodStart).toLocaleDateString('pt-BR')} - ${new Date(doc.periodEnd).toLocaleDateString('pt-BR')}`
}

async function closePeriod() {
  error.value = ''
  closing.value = true
  try {
    await api('/admin/finance/close', {
      method: 'POST',
      body: JSON.stringify({
        periodStart: dateToIso(periodStart.value),
        periodEnd: dateToIso(periodEnd.value, 1),
      }),
    })
    await load()
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Erro'
  } finally {
    closing.value = false
  }
}

async function markPaid(kind: 'store-invoices' | 'store-payouts' | 'driver-payouts', id: string) {
  error.value = ''
  try {
    await api(`/admin/finance/${kind}/${id}/paid`, { method: 'PATCH' })
    await load()
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Erro'
  }
}

const openTotals = computed(() => ({
  invoice: data.value.storeInvoices.filter((d) => d.status === 'OPEN').reduce((sum, d) => sum + d.totalCents, 0),
  stores: data.value.storePayouts.filter((d) => d.status === 'OPEN').reduce((sum, d) => sum + d.totalCents, 0),
  drivers: data.value.driverPayouts.filter((d) => d.status === 'OPEN').reduce((sum, d) => sum + d.totalCents, 0),
}))
</script>

<template>
  <main class="mx-auto max-w-4xl space-y-5 p-4">
    <div class="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 class="text-xl font-bold">Financeiro</h1>
        <p class="text-sm text-gray-500">
          Cobrar {{ formatBRL(openTotals.invoice) }} · repassar lojas {{ formatBRL(openTotals.stores) }} · repassar entregadores {{ formatBRL(openTotals.drivers) }}
        </p>
      </div>
      <form class="flex flex-wrap items-end gap-2 text-sm" @submit.prevent="closePeriod">
        <label class="grid gap-1">
          <span class="text-xs text-gray-500">Início</span>
          <input v-model="periodStart" type="date" class="rounded border p-2" />
        </label>
        <label class="grid gap-1">
          <span class="text-xs text-gray-500">Fim</span>
          <input v-model="periodEnd" type="date" class="rounded border p-2" />
        </label>
        <button :disabled="closing" class="rounded bg-black px-3 py-2 text-white disabled:opacity-50">
          {{ closing ? 'Fechando...' : 'Fechar' }}
        </button>
      </form>
    </div>
    <p v-if="error" class="text-sm text-red-600">{{ error }}</p>

    <section class="space-y-2">
      <h2 class="font-semibold">Faturas da loja</h2>
      <ul class="divide-y rounded border">
        <li v-for="doc in data.storeInvoices" :key="doc.id" class="flex items-center justify-between gap-3 p-3">
          <div>
            <p class="font-medium">{{ doc.storeName }} · {{ formatBRL(doc.totalCents) }}</p>
            <p class="text-xs text-gray-500">{{ period(doc) }} · {{ FINANCE_DOCUMENT_STATUS_LABELS[doc.status] }}</p>
          </div>
          <button v-if="doc.status === 'OPEN'" class="rounded border px-2 py-1 text-sm" @click="markPaid('store-invoices', doc.id)">Pago</button>
        </li>
        <li v-if="data.storeInvoices.length === 0" class="p-3 text-sm text-gray-400">Sem faturas.</li>
      </ul>
    </section>

    <section class="space-y-2">
      <h2 class="font-semibold">Repasses para lojas</h2>
      <ul class="divide-y rounded border">
        <li v-for="doc in data.storePayouts" :key="doc.id" class="flex items-center justify-between gap-3 p-3">
          <div>
            <p class="font-medium">{{ doc.storeName }} · {{ formatBRL(doc.totalCents) }}</p>
            <p class="text-xs text-gray-500">{{ period(doc) }} · {{ FINANCE_DOCUMENT_STATUS_LABELS[doc.status] }}</p>
          </div>
          <button v-if="doc.status === 'OPEN'" class="rounded border px-2 py-1 text-sm" @click="markPaid('store-payouts', doc.id)">Pago</button>
        </li>
        <li v-if="data.storePayouts.length === 0" class="p-3 text-sm text-gray-400">Sem repasses.</li>
      </ul>
    </section>

    <section class="space-y-2">
      <h2 class="font-semibold">Repasses para entregadores</h2>
      <ul class="divide-y rounded border">
        <li v-for="doc in data.driverPayouts" :key="doc.id" class="flex items-center justify-between gap-3 p-3">
          <div>
            <p class="font-medium">{{ doc.driverName }} · {{ formatBRL(doc.totalCents) }}</p>
            <p class="text-xs text-gray-500">{{ period(doc) }} · {{ FINANCE_DOCUMENT_STATUS_LABELS[doc.status] }}</p>
          </div>
          <button v-if="doc.status === 'OPEN'" class="rounded border px-2 py-1 text-sm" @click="markPaid('driver-payouts', doc.id)">Pago</button>
        </li>
        <li v-if="data.driverPayouts.length === 0" class="p-3 text-sm text-gray-400">Sem repasses.</li>
      </ul>
    </section>
  </main>
</template>
