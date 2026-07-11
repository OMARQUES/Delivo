<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import {
  FINANCE_DOCUMENT_STATUS_LABELS,
  LEDGER_ENTRY_LABELS,
  formatBRL,
  type FinanceDocumentStatus,
  type LedgerEntryType,
} from '@delivery/shared/constants'
import { api } from '../lib/api'

type LedgerEntry = {
  id: string
  type: LedgerEntryType
  amountCents: number
  description: string
  createdAt: string
  orderId: string | null
}
type FinanceDoc = {
  id: string
  periodStart: string
  periodEnd: string
  status: FinanceDocumentStatus
  totalCents: number
  paidAt: string | null
}
type DriverFinance = {
  ledger: LedgerEntry[]
  payouts: FinanceDoc[]
}
type EarningDetail = {
  orderId: string
  createdAt: string
  status: string
  storeName: string
  items: { nameSnapshot: string; quantity: number }[]
  ledger: Pick<LedgerEntry, 'type' | 'amountCents' | 'description' | 'createdAt'>[]
}

const finance = ref<DriverFinance>({ ledger: [], payouts: [] })
const error = ref('')
const detail = ref<EarningDetail | null>(null)
const detailError = ref('')

async function load() {
  finance.value = await api<DriverFinance>('/driver/me/finance')
}
onMounted(() => load().catch((e) => (error.value = e instanceof Error ? e.message : 'Erro')))

function period(doc: FinanceDoc) {
  return `${new Date(doc.periodStart).toLocaleDateString('pt-BR')} - ${new Date(doc.periodEnd).toLocaleDateString('pt-BR')}`
}

function signed(value: number) {
  return `${value >= 0 ? '+' : '-'}${formatBRL(Math.abs(value))}`
}

const toReceive = computed(() =>
  finance.value.payouts.filter((d) => d.status === 'OPEN').reduce((sum, d) => sum + d.totalCents, 0),
)

async function openDetail(entry: LedgerEntry) {
  if (!entry.orderId) return
  detailError.value = ''
  try { detail.value = await api<EarningDetail>(`/driver/earnings/orders/${entry.orderId}`) }
  catch (e) { detailError.value = e instanceof Error ? e.message : 'Erro' }
}
</script>

<template>
  <main class="mx-auto max-w-lg space-y-5 p-4">
    <div>
      <h1 class="text-xl font-bold">Ganhos</h1>
      <p class="text-sm text-gray-500">A receber {{ formatBRL(toReceive) }}</p>
    </div>
    <p v-if="error" class="text-sm text-red-600">{{ error }}</p>

    <section class="space-y-2">
      <h2 class="font-semibold">Repasses</h2>
      <ul class="divide-y rounded border">
        <li v-for="doc in finance.payouts" :key="doc.id" class="p-3">
          <p class="font-medium">{{ formatBRL(doc.totalCents) }}</p>
          <p class="text-xs text-gray-500">{{ period(doc) }} · {{ FINANCE_DOCUMENT_STATUS_LABELS[doc.status] }}</p>
        </li>
        <li v-if="finance.payouts.length === 0" class="p-3 text-sm text-gray-400">Sem repasses.</li>
      </ul>
    </section>

    <section class="space-y-2">
      <h2 class="font-semibold">Extrato</h2>
      <ul class="divide-y rounded border">
        <li
          v-for="entry in finance.ledger" :key="entry.id"
          class="flex items-center justify-between gap-3 p-3"
          :class="entry.orderId && 'cursor-pointer hover:bg-gray-50'"
          :tabindex="entry.orderId ? 0 : undefined"
          @click="openDetail(entry)"
          @keydown.enter="openDetail(entry)"
        >
          <div>
            <p class="font-medium">{{ LEDGER_ENTRY_LABELS[entry.type] }}</p>
            <p class="text-xs text-gray-500">{{ entry.description }} · {{ new Date(entry.createdAt).toLocaleString('pt-BR') }}</p>
          </div>
          <span class="text-sm font-semibold" :class="entry.amountCents >= 0 ? 'text-green-700' : 'text-red-600'">{{ signed(entry.amountCents) }}</span>
        </li>
        <li v-if="finance.ledger.length === 0" class="p-3 text-sm text-gray-400">Sem lançamentos.</li>
      </ul>
    </section>
    <p v-if="detailError" class="text-sm text-red-600">{{ detailError }}</p>
  </main>

  <div v-if="detail" class="fixed inset-0 z-10 flex items-center justify-center bg-black/40 p-4" @click.self="detail = null">
    <div class="max-h-[85vh] w-full max-w-sm overflow-y-auto rounded bg-white p-4">
      <h2 class="text-lg font-bold">Detalhe do ganho</h2>
      <p class="text-sm text-gray-600">{{ detail.storeName }} · {{ new Date(detail.createdAt).toLocaleString('pt-BR') }}</p>
      <h3 class="mt-3 font-semibold">Itens</h3>
      <ul class="text-sm"><li v-for="item in detail.items" :key="item.nameSnapshot">{{ item.quantity }}× {{ item.nameSnapshot }}</li></ul>
      <h3 class="mt-3 font-semibold">Lançamentos</h3>
      <ul class="divide-y text-sm">
        <li v-for="entry in detail.ledger" :key="`${entry.type}-${entry.createdAt}`" class="flex justify-between gap-3 py-2">
          <span>{{ LEDGER_ENTRY_LABELS[entry.type] }}<small class="block text-gray-500">{{ entry.description }} · {{ new Date(entry.createdAt).toLocaleString('pt-BR') }}</small></span>
          <strong :class="entry.amountCents >= 0 ? 'text-green-700' : 'text-red-600'">{{ signed(entry.amountCents) }}</strong>
        </li>
      </ul>
      <button class="mt-4 w-full rounded bg-black p-2 text-white" @click="detail = null">Fechar</button>
    </div>
  </div>
</template>
