<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { formatBRL, ORDER_STATUS_LABELS, type OrderStatus } from '@delivery/shared/constants'
import { api } from '../../lib/api'

type OrderRow = {
  id: string
  status: OrderStatus
  fulfillment: 'DELIVERY' | 'PICKUP'
  driverId: string | null
  driverRequestedAt: string | null
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
  driverName: string | null
  driverPhone: string | null
  items: { id: string; nameSnapshot: string; quantity: number; totalCents: number; note: string | null; options: { label: string }[] }[]
  amendment: {
    id: string
    note: string | null
    refundCents: number
    newTotalCents: number
    items: { nameSnapshot: string; oldQuantity: number; newQuantity: number }[]
  } | null
}

const active = ref<OrderRow[]>([])
const done = ref<OrderRow[]>([])
const detail = ref<Detail | null>(null)
const error = ref('')
const amending = ref(false)
const amendQty = ref<Record<string, number>>({})
const amendNote = ref('')
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
    if (detail.value) {
      try {
        detail.value = await api<Detail>(`/store/me/orders/${detail.value.id}`)
      } catch {
        // Detalhe pode ter saído da janela; ignora.
      }
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Erro'
  }
}

onMounted(() => {
  load()
  timer = setInterval(load, 1_000)
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

async function requestDriver(o: OrderRow) {
  error.value = ''
  try {
    await api(`/store/me/orders/${o.id}/request-driver`, { method: 'POST' })
    await load()
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Erro'
  }
}

async function openDetail(o: OrderRow) {
  detail.value = await api<Detail>(`/store/me/orders/${o.id}`)
  amending.value = false
  amendQty.value = {}
  amendNote.value = ''
}

function printOrder() {
  window.print()
}

function startAmend() {
  if (!detail.value) return
  amendQty.value = Object.fromEntries(detail.value.items.map((i) => [i.id, i.quantity]))
  amendNote.value = ''
  amending.value = true
}

function setAmendQty(itemId: string, max: number, value: string) {
  const n = Number(value)
  amendQty.value[itemId] = Number.isFinite(n) ? Math.min(max, Math.max(0, Math.trunc(n))) : max
}

async function submitAmend() {
  if (!detail.value) return
  error.value = ''
  const items = detail.value.items
    .filter((i) => (amendQty.value[i.id] ?? i.quantity) < i.quantity)
    .map((i) => ({ orderItemId: i.id, newQuantity: amendQty.value[i.id] ?? i.quantity }))
  if (items.length === 0) {
    error.value = 'Reduza a quantidade de pelo menos um item'
    return
  }
  try {
    await api(`/store/me/orders/${detail.value.id}/amendments`, {
      method: 'POST',
      body: JSON.stringify({ note: amendNote.value || undefined, items }),
    })
    amending.value = false
    await openDetail(detail.value)
    await load()
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Erro'
  }
}

async function withdrawAmend() {
  if (!detail.value) return
  error.value = ''
  try {
    await api(`/store/me/orders/${detail.value.id}/amendments/current`, { method: 'DELETE' })
    await openDetail(detail.value)
    await load()
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Erro'
  }
}

function paymentLabel(o: { paymentMethod: string; changeForCents: number | null }) {
  if (o.paymentMethod === 'CASH') return `Dinheiro${o.changeForCents ? ` (troco p/ ${formatBRL(o.changeForCents)})` : ''}`
  if (o.paymentMethod === 'CARD_MACHINE') return 'Maquininha'
  if (o.paymentMethod === 'PIX_ONLINE') return '✅ PIX pago'
  return '✅ Cartão pago'
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
                {{ paymentLabel(o) }}
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
            <button
              v-if="o.fulfillment === 'DELIVERY' && !o.driverId && !o.driverRequestedAt && ['ACCEPTED', 'PREPARING', 'READY', 'AWAITING_DRIVER'].includes(o.status)"
              class="rounded border px-2 py-1"
              @click="requestDriver(o)"
            >🛵 Solicitar entregador</button>
            <span v-else-if="o.fulfillment === 'DELIVERY' && !o.driverId && o.driverRequestedAt" class="rounded bg-blue-100 px-2 py-1 text-xs">
              aguardando entregador...
            </span>
            <span v-else-if="o.driverId" class="rounded bg-green-100 px-2 py-1 text-xs">entregador a caminho</span>
            <button class="rounded border px-2 py-1" @click="openDetail(o)">Detalhes</button>
            <button
              v-if="!['DELIVERED', 'CANCELLED', 'DELIVERY_FAILED'].includes(o.status)"
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
        {{ paymentLabel(detail) }}
      </p>
      <p v-if="detail.taxId" class="text-sm text-gray-600">CPF/CNPJ na nota: {{ detail.taxId }}</p>
      <p v-if="detail.driverName" class="text-sm text-gray-600">
        Entregador: {{ detail.driverName }}
        <a v-if="detail.driverPhone" :href="`https://wa.me/55${detail.driverPhone}`" target="_blank" class="underline">WhatsApp</a>
      </p>
      <ul class="mt-2 space-y-1 text-sm">
        <li v-for="i in detail.items" :key="i.id">
          {{ i.quantity }}× {{ i.nameSnapshot }}
          <span class="text-gray-500">{{ i.options.map((x) => x.label).join(', ') }}</span>
          <em v-if="i.note" class="block text-xs">Obs: {{ i.note }}</em>
          <span class="float-right">{{ formatBRL(i.totalCents) }}</span>
        </li>
      </ul>
      <div v-if="detail.amendment" class="mt-2 rounded bg-yellow-50 p-2 text-sm">
        <p class="font-medium">Alteração aguardando o cliente</p>
        <p v-for="i in detail.amendment.items" :key="`${detail.amendment.id}-${i.nameSnapshot}`" class="text-xs">
          {{ i.nameSnapshot }}: {{ i.oldQuantity }}× → {{ i.newQuantity }}×
        </p>
        <p class="text-xs">Novo total {{ formatBRL(detail.amendment.newTotalCents) }}</p>
        <button class="mt-1 underline" @click="withdrawAmend">Retirar proposta</button>
      </div>
      <button
        v-else-if="['ACCEPTED', 'PREPARING'].includes(detail.status)"
        class="mt-2 rounded border px-2 py-1 text-sm"
        @click="startAmend"
      >
        Propor alteração (item em falta)
      </button>

      <div v-if="amending" class="mt-2 space-y-2 rounded border p-2">
        <p class="text-sm font-semibold">Reduza as quantidades (0 = remover):</p>
        <div v-for="i in detail.items" :key="i.id" class="flex items-center gap-2 text-sm">
          <span class="flex-1">{{ i.nameSnapshot }} (atual: {{ i.quantity }})</span>
          <input
            type="number"
            :max="i.quantity"
            min="0"
            :value="amendQty[i.id]"
            class="w-16 rounded border p-1"
            @input="setAmendQty(i.id, i.quantity, ($event.target as HTMLInputElement).value)"
          />
        </div>
        <input v-model="amendNote" placeholder="Motivo (ex.: acabou o catupiry)" class="w-full rounded border p-2 text-sm" />
        <div class="flex gap-2">
          <button class="flex-1 rounded border p-1 text-sm" @click="amending = false">Voltar</button>
          <button class="flex-1 rounded bg-black p-1 text-sm text-white" @click="submitAmend">Enviar ao cliente</button>
        </div>
      </div>
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
