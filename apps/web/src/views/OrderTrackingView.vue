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
  paymentMethod: string
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
  payment: { qrCode: string | null; qrCodeBase64: string | null; expiresAt: string | null } | null
  paymentResolution: 'PROCESSING' | 'NOT_CHARGED' | 'REFUNDED' | 'REVIEW_REQUIRED' | null
  amendment: {
    note: string | null
    refundCents: number
    newTotalCents: number
    items: { nameSnapshot: string; oldQuantity: number; newQuantity: number }[]
  } | null
  events: { status: OrderStatus; createdAt: string; note: string | null }[]
}

const route = useRoute()
const order = ref<Order | null>(null)
const error = ref('')
const copied = ref(false)
const isCancelling = ref(false)
const now = ref(Date.now())
let timer: ReturnType<typeof setInterval> | undefined
let clockTimer: ReturnType<typeof setInterval> | undefined

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
  timer = setInterval(load, 1_000)
  clockTimer = setInterval(() => (now.value = Date.now()), 1000)
})
onBeforeUnmount(() => {
  clearInterval(timer)
  clearInterval(clockTimer)
})

const stepIndex = computed(() => (order.value ? STEPS.indexOf(order.value.status) : -1))
const isFinal = computed(() => order.value && ['DELIVERED', 'CANCELLED', 'DELIVERY_FAILED'].includes(order.value.status))
const paymentCountdown = computed(() => {
  const exp = order.value?.payment?.expiresAt
  if (!exp) return null
  const ms = new Date(exp).getTime() - now.value
  if (ms <= 0) return 'instantes'
  const m = Math.floor(ms / 60000)
  const s = Math.floor((ms % 60000) / 1000)
  return `${m}m${String(s).padStart(2, '0')}s`
})

function copyPix() {
  const qrCode = order.value?.payment?.qrCode
  if (!qrCode) return
  navigator.clipboard.writeText(qrCode)
  copied.value = true
  setTimeout(() => (copied.value = false), 3000)
}

async function cancel() {
  if (!order.value || isCancelling.value) return
  const message = order.value.status === 'AWAITING_PAYMENT'
    ? 'Cancelar o pagamento e o pedido? Se a cobrança for aprovada ao mesmo tempo, o estorno será solicitado automaticamente.'
    : 'Cancelar este pedido?'
  if (!confirm(message)) return
  isCancelling.value = true
  try {
    await api(`/orders/${order.value.id}/cancel`, { method: 'POST' })
    await load()
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Erro'
  } finally {
    isCancelling.value = false
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

async function resolveAmendment(action: 'approve' | 'reject') {
  if (!order.value) return
  const label = action === 'approve' ? 'Aprovar a alteração?' : 'Recusar? O pedido será CANCELADO.'
  if (!confirm(label)) return
  try {
    await api(`/orders/${order.value.id}/amendments/current/${action}`, { method: 'POST' })
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
        <p v-if="order.paymentResolution === 'PROCESSING'">Pedido cancelado — confirmação financeira em processamento.</p>
        <p v-else-if="order.paymentResolution === 'NOT_CHARGED'">Pedido cancelado — nenhuma cobrança foi concluída.</p>
        <p v-else-if="order.paymentResolution === 'REFUNDED'">Pedido cancelado — pagamento estornado.</p>
        <p v-else-if="order.paymentResolution === 'REVIEW_REQUIRED'">Pedido cancelado — confirmação financeira em análise.</p>
        <p v-else>Cancelado{{ order.cancelReason ? ` — ${order.cancelReason}` : '' }}</p>
      </section>
      <section v-else-if="order.status === 'DELIVERY_FAILED'" class="rounded border border-red-300 bg-red-50 p-3">
        Entrega não realizada. Entre em contato com a loja.
      </section>
      <section v-else-if="order.status === 'AWAITING_PAYMENT' && order.payment?.qrCode" class="space-y-2 rounded border border-blue-300 bg-blue-50 p-3">
        <p class="font-semibold">Pague com PIX para confirmar o pedido</p>
        <img
          v-if="order.payment.qrCodeBase64"
          :src="`data:image/png;base64,${order.payment.qrCodeBase64}`"
          class="mx-auto h-48 w-48"
          alt="QR Code PIX"
        />
        <div class="flex gap-2">
          <input :value="order.payment.qrCode" readonly class="flex-1 rounded border bg-white p-2 text-xs" />
          <button class="rounded bg-black px-3 text-white" @click="copyPix">Copiar</button>
        </div>
        <p class="text-xs text-gray-600">
          {{ copied ? 'Copiado! Cole no app do seu banco.' : 'Escaneie o QR ou copie o código.' }}
          <span v-if="paymentCountdown"> Expira em {{ paymentCountdown }}.</span>
        </p>
      </section>
      <section v-else-if="order.status === 'AWAITING_PAYMENT'" class="rounded border border-blue-300 bg-blue-50 p-3">
        <p>Aguardando confirmação do pagamento…</p>
        <p v-if="paymentCountdown" class="mt-1 text-sm text-gray-600">Esta tentativa expira em {{ paymentCountdown }}.</p>
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

      <section v-if="order.amendment && !isFinal" class="space-y-2 rounded border border-orange-300 bg-orange-50 p-3">
        <p class="font-semibold">A loja propôs uma alteração</p>
        <p v-if="order.amendment.note" class="text-sm italic">"{{ order.amendment.note }}"</p>
        <ul class="text-sm">
          <li v-for="(i, idx) in order.amendment.items" :key="idx">
            {{ i.nameSnapshot }}: {{ i.oldQuantity }}× →
            <strong>{{ i.newQuantity === 0 ? 'remover' : `${i.newQuantity}×` }}</strong>
          </li>
        </ul>
        <p class="text-sm">
          Novo total: <strong>{{ formatBRL(order.amendment.newTotalCents) }}</strong>
          <span v-if="order.amendment.refundCents > 0" class="text-green-700">
            (−{{ formatBRL(order.amendment.refundCents) }}<template v-if="order.paymentMethod.includes('ONLINE')"> — estorno automático</template>)
          </span>
        </p>
        <div class="flex gap-2">
          <button class="flex-1 rounded bg-green-600 p-2 text-white" @click="resolveAmendment('approve')">Aprovar</button>
          <button class="flex-1 rounded border border-red-400 p-2 text-red-600" @click="resolveAmendment('reject')">Recusar (cancela)</button>
        </div>
      </section>

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
        <button v-if="order.status === 'PENDING' || order.status === 'AWAITING_PAYMENT'" :data-testid="order.status === 'AWAITING_PAYMENT' ? 'cancel-awaiting-payment' : 'cancel-payment'" :disabled="isCancelling" class="flex-1 rounded border border-red-400 p-2 text-red-600 disabled:opacity-50" @click="cancel">
          {{ isCancelling ? 'Cancelando…' : order.status === 'AWAITING_PAYMENT' ? 'Cancelar pagamento e pedido' : 'Cancelar pedido' }}
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
