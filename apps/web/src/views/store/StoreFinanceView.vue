<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import {
  FINANCE_DOCUMENT_STATUS_LABELS,
  LEDGER_ENTRY_LABELS,
  formatBRL,
  type FinanceDocumentStatus,
  type LedgerEntryType,
} from '@delivery/shared/constants'
import { api } from '../../lib/api'

type LedgerEntry = {
  id: string
  type: LedgerEntryType
  amountCents: number
  description: string
  createdAt: string
}
type FinanceDoc = {
  id: string
  periodStart: string
  periodEnd: string
  status: FinanceDocumentStatus
  totalCents: number
  paidAt: string | null
}
type StoreFinance = {
  ledger: LedgerEntry[]
  invoices: FinanceDoc[]
  payouts: FinanceDoc[]
}

const finance = ref<StoreFinance>({ ledger: [], invoices: [], payouts: [] })
const error = ref('')

async function load() {
  finance.value = await api<StoreFinance>('/store/me/finance')
}
onMounted(() => load().catch((e) => (error.value = e instanceof Error ? e.message : 'Erro')))

function period(doc: FinanceDoc) {
  return `${new Date(doc.periodStart).toLocaleDateString('pt-BR')} - ${new Date(doc.periodEnd).toLocaleDateString('pt-BR')}`
}

function signed(value: number) {
  return `${value >= 0 ? '+' : '-'}${formatBRL(Math.abs(value))}`
}

const totals = computed(() => ({
  toPay: finance.value.invoices.filter((d) => d.status === 'OPEN').reduce((sum, d) => sum + d.totalCents, 0),
  toReceive: finance.value.payouts.filter((d) => d.status === 'OPEN').reduce((sum, d) => sum + d.totalCents, 0),
}))
</script>

<template>
  <main class="mx-auto max-w-3xl space-y-5 p-4">
    <div>
      <h1 class="text-xl font-bold">Financeiro</h1>
      <p class="text-sm text-gray-500">
        A pagar {{ formatBRL(totals.toPay) }} · a receber {{ formatBRL(totals.toReceive) }}
      </p>
    </div>
    <p v-if="error" class="text-sm text-red-600">{{ error }}</p>

    <section class="space-y-2">
      <h2 class="font-semibold">Faturas</h2>
      <ul class="divide-y rounded border">
        <li v-for="doc in finance.invoices" :key="doc.id" class="p-3">
          <p class="font-medium">{{ formatBRL(doc.totalCents) }}</p>
          <p class="text-xs text-gray-500">{{ period(doc) }} · {{ FINANCE_DOCUMENT_STATUS_LABELS[doc.status] }}</p>
        </li>
        <li v-if="finance.invoices.length === 0" class="p-3 text-sm text-gray-400">Sem faturas.</li>
      </ul>
    </section>

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
        <li v-for="entry in finance.ledger" :key="entry.id" class="flex items-center justify-between gap-3 p-3">
          <div>
            <p class="font-medium">{{ LEDGER_ENTRY_LABELS[entry.type] }}</p>
            <p class="text-xs text-gray-500">{{ entry.description }} · {{ new Date(entry.createdAt).toLocaleDateString('pt-BR') }}</p>
          </div>
          <span class="text-sm font-semibold" :class="entry.amountCents >= 0 ? 'text-green-700' : 'text-red-600'">{{ signed(entry.amountCents) }}</span>
        </li>
        <li v-if="finance.ledger.length === 0" class="p-3 text-sm text-gray-400">Sem lançamentos.</li>
      </ul>
    </section>
  </main>
</template>
