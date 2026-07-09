<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { formatBRL, ORDER_STATUS_LABELS, type OrderStatus } from '@delivery/shared/constants'
import { api } from '../../lib/api'

type OrderRow = {
  id: string
  status: OrderStatus
  fulfillment: 'DELIVERY' | 'PICKUP'
  paymentMethod: string
  changeForCents: number | null
  totalCents: number
  createdAt: string
  customerName: string
  customerPhone: string | null
  isFirstOrder: boolean
  cancelRequestedAt: string | null
  cancelRequestNote: string | null
  addressText: string | null
  note: string | null
  taxId: string | null
}
type Detail = OrderRow & {
  subtotalCents: number
  deliveryFeeCents: number | null
  items: { id: string; nameSnapshot: string; quantity: number; totalCents: number; note: string | null; options: { label: string }[] }[]
}

const active = ref<OrderRow[]>([])
const done = ref<OrderRow[]>([])
const detail = ref<Detail | null>(null)
const error = ref('')
let timer: ReturnType<typeof setInterval> | undefined
let knownPending = new Set<string>()
let firstLoad = true

function beep() {
  try {
    const ctx = new AudioContext()
    const osc = ctx.createOscillator()
    osc.type = 'square'
    osc.frequency.value = 880
    osc.connect(ctx.destination)
    osc.start()
    setTimeout(() => {
      osc.stop()
      ctx.close()
    }, 400)
  } catch {
    // Browser may block audio until user interaction.
  }
}

async function load() {
  try {
    const [a, d] = await Promise.all([
      api<OrderRow[]>('/store/me/orders?scope=active'),
      api<OrderRow[]>('/store/me/orders?scope=done'),
    ])
    const pendingIds = new Set(a.filter((o) => o.status === 'PENDING').map((o) => o.id))
    if (!firstLoad && [...pendingIds].some((id) => !knownPending.has(id))) beep()
    knownPending = pendingIds
    firstLoad = false
    active.value = a
    done.value = d
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Erro'
  }
}

onMounted(() => {
  load()
  timer = setInterval(load, 15_000)
})
onBeforeUnmount(() => clearInterval(timer))

const NEXT: Partial<Record<OrderStatus, { to: OrderStatus; label: string }[]>> = {
  PENDING: [{ to: 'ACCEPTED', label: 'Aceitar' }],
  ACCEPTED: [{ to: 'PREPARING', label: 'Em preparo' }],
  PREPARING: [{ to: 'READY', label: 'Pronto' }],
  READY: [
    { to: 'OUT_FOR_DELIVERY', label: 'Saiu p/ entrega' },
    { to: 'DELIVERED', label: 'Cliente retirou' },
  ],
  OUT_FOR_DELIVERY: [{ to: 'DELIVERED', label: 'Entregue' }],
}

function actionsFor(o: OrderRow) {
  return (NEXT[o.status] ?? []).filter((a) => {
    if (a.to === 'OUT_FOR_DELIVERY' && o.fulfillment === 'PICKUP') return false
    if (a.to === 'DELIVERED' && o.status === 'READY' && o.fulfillment === 'DELIVERY') return false
    return true
  })
}

async function setStatus(o: OrderRow, to: OrderStatus) {
  error.value = ''
  try {
    let reason: string | undefined
    if (to === 'CANCELLED') {
      reason = prompt('Motivo do cancelamento:') ?? undefined
      if (!reason) return
    }
    await api(`/store/me/orders/${o.id}/status`, { method: 'PATCH', body: JSON.stringify({ to, reason }) })
    await load()
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Erro'
  }
}

async function resolveCancel(o: OrderRow, approve: boolean) {
  await api(`/store/me/orders/${o.id}/cancel-request/${approve ? 'approve' : 'deny'}`, { method: 'POST' })
  await load()
}

async function openDetail(o: OrderRow) {
  detail.value = await api<Detail>(`/store/me/orders/${o.id}`)
}

function printOrder() {
  window.print()
}

const wa = (phone: string | null) => (phone ? `https://wa.me/55${phone}` : null)
const dt = (iso: string) => new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
const groups = computed(() => {
  const g: Record<string, OrderRow[]> = {}
  for (const o of active.value) (g[o.status] ??= []).push(o)
  return g
})
</script>

<template>
  <main class="mx-auto max-w-3xl p-4 print:hidden">
    <h1 class="text-xl font-bold">Pedidos</h1>
    <p v-if="error" class="text-sm text-red-600">{{ error }}</p>

    <section v-for="(list, status) in groups" :key="status" class="mt-4">
      <h2 class="font-semibold">{{ ORDER_STATUS_LABELS[status as OrderStatus] }} ({{ list.length }})</h2>
      <ul class="mt-1 space-y-2">
        <li v-for="o in list" :key="o.id" class="rounded border p-3" :class="o.status === 'PENDING' && 'border-yellow-500 bg-yellow-50'">
          <div class="flex items-center justify-between text-sm">
            <span>
              <strong>{{ o.customerName }}</strong>
              <span v-if="o.isFirstOrder" class="ml-1 rounded bg-blue-100 px-1 text-xs">🆕 1º pedido</span>
              <a v-if="wa(o.customerPhone)" :href="wa(o.customerPhone)!" target="_blank" class="ml-2 underline">WhatsApp</a>
              <span class="block text-xs text-gray-500">
                {{ dt(o.createdAt) }} · {{ o.fulfillment === 'PICKUP' ? 'Retirada' : 'Entrega' }} ·
                {{ o.paymentMethod === 'CASH' ? `Dinheiro${o.changeForCents ? ` (troco p/ ${formatBRL(o.changeForCents)})` : ''}` : 'Maquininha' }}
              </span>
              <span v-if="o.addressText" class="block text-xs text-gray-500">{{ o.addressText }}</span>
              <span v-if="o.note" class="block text-xs italic">Obs: {{ o.note }}</span>
            </span>
            <span class="font-semibold">{{ formatBRL(o.totalCents) }}</span>
          </div>
          <p v-if="o.cancelRequestedAt" class="mt-1 rounded bg-yellow-100 p-1 text-xs">
            Cliente pediu cancelamento{{ o.cancelRequestNote ? `: "${o.cancelRequestNote}"` : '' }}
            <button class="ml-2 underline" @click="resolveCancel(o, true)">Aprovar</button>
            <button class="ml-2 underline" @click="resolveCancel(o, false)">Negar</button>
          </p>
          <div class="mt-2 flex flex-wrap gap-2 text-sm">
            <button v-for="a in actionsFor(o)" :key="a.to" class="rounded bg-black px-2 py-1 text-white" @click="setStatus(o, a.to)">
              {{ a.label }}
            </button>
            <button class="rounded border px-2 py-1" @click="openDetail(o)">Detalhes</button>
            <button
              v-if="!['DELIVERED', 'CANCELLED'].includes(o.status)"
              class="rounded border border-red-400 px-2 py-1 text-red-600"
              @click="setStatus(o, 'CANCELLED')"
            >
              Cancelar
            </button>
          </div>
        </li>
      </ul>
    </section>
    <p v-if="active.length === 0" class="mt-4 text-gray-500">Nenhum pedido ativo.</p>

    <details class="mt-6">
      <summary class="cursor-pointer font-semibold">Concluídos/cancelados recentes ({{ done.length }})</summary>
      <ul class="mt-2 space-y-1 text-sm">
        <li v-for="o in done" :key="o.id" class="flex justify-between rounded border p-2">
          <span>{{ o.customerName }} · {{ ORDER_STATUS_LABELS[o.status] }}</span>
          <span>{{ formatBRL(o.totalCents) }}</span>
        </li>
      </ul>
    </details>
  </main>

  <div v-if="detail" class="fixed inset-0 z-10 flex items-center justify-center bg-black/40 print:static print:bg-transparent" @click.self="detail = null">
    <div class="max-h-[85vh] w-full max-w-md overflow-y-auto rounded bg-white p-4 print:max-h-none print:shadow-none">
      <h2 class="text-lg font-bold">Pedido — {{ detail.customerName }}</h2>
      <p class="text-sm text-gray-600">
        {{ detail.fulfillment === 'PICKUP' ? 'Retirada' : `Entrega: ${detail.addressText}` }} ·
        {{ detail.paymentMethod === 'CASH' ? 'Dinheiro' : 'Maquininha' }}
        <template v-if="detail.changeForCents"> · troco p/ {{ formatBRL(detail.changeForCents) }}</template>
      </p>
      <p v-if="detail.taxId" class="text-sm text-gray-600">CPF/CNPJ na nota: {{ detail.taxId }}</p>
      <ul class="mt-2 space-y-1 text-sm">
        <li v-for="i in detail.items" :key="i.id">
          {{ i.quantity }}× {{ i.nameSnapshot }}
          <span class="text-gray-500">{{ i.options.map((x) => x.label).join(', ') }}</span>
          <em v-if="i.note" class="block text-xs">Obs: {{ i.note }}</em>
          <span class="float-right">{{ formatBRL(i.totalCents) }}</span>
        </li>
      </ul>
      <hr class="my-2" />
      <p class="flex justify-between text-sm"><span>Subtotal</span><span>{{ formatBRL(detail.subtotalCents) }}</span></p>
      <p v-if="detail.deliveryFeeCents != null" class="flex justify-between text-sm"><span>Entrega</span><span>{{ formatBRL(detail.deliveryFeeCents) }}</span></p>
      <p class="flex justify-between font-bold"><span>Total</span><span>{{ formatBRL(detail.totalCents) }}</span></p>
      <div class="mt-3 flex gap-2 print:hidden">
        <button class="flex-1 rounded border p-2" @click="printOrder">Imprimir</button>
        <button class="flex-1 rounded bg-black p-2 text-white" @click="detail = null">Fechar</button>
      </div>
    </div>
  </div>
</template>
