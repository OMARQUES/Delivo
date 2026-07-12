<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { formatBRL } from '@delivery/shared/constants'
import MapPicker from '../components/MapPicker.vue'
import { api } from '../lib/api'
import { cardConfigured, mountCardBrick, type CardFormData } from '../lib/mp-brick'
import { useCartStore } from '../stores/cart'
import { useAuthStore } from '../stores/auth'

type Address = { id: string; label: string | null; addressText: string; reference: string | null; lat: number; lng: number }
type Quote = { subtotalCents: number; deliveryFeeCents: number | null; totalCents: number; problems: string[] }

const router = useRouter()
const cart = useCartStore()
const auth = useAuthStore()

const fulfillment = ref<'DELIVERY' | 'PICKUP'>('DELIVERY')
const addresses = ref<Address[]>([])
const addressId = ref('')
const paymentMethod = ref<'CASH' | 'CARD_MACHINE' | 'PIX_ONLINE' | 'CARD_ONLINE'>('CASH')
const changeFor = ref('')
const cardAvailable = cardConfigured()
const cardData = ref<CardFormData | null>(null)
const taxId = ref('')
const note = ref('')
const quote = ref<Quote | null>(null)
const error = ref('')
const submitting = ref(false)
const showContactPrompt = ref(false)
const contactPhone = ref('')
const contactWarning = ref('')
const savingContact = ref(false)
const contactPromptHandled = ref(false)
const idempotencyKey = crypto.randomUUID()
let destroyBrick: (() => void) | null = null

const showNewAddress = ref(false)
const newAddr = reactive({ label: '', addressText: '', reference: '', lat: -23.55, lng: -51.93 })

function checkoutBody() {
  const body = {
    storeSlug: cart.storeSlug,
    fulfillment: fulfillment.value,
    addressId: fulfillment.value === 'DELIVERY' ? addressId.value || undefined : undefined,
    paymentMethod: paymentMethod.value,
    changeForCents: paymentMethod.value === 'CASH' && changeFor.value
      ? Math.round(Number(changeFor.value.replace(',', '.')) * 100)
      : undefined,
    taxId: taxId.value || undefined,
    note: note.value || undefined,
    items: cart.items.map((i) => ({
      productId: i.productId,
      quantity: i.quantity,
      note: i.note || undefined,
      selections: i.selections,
    })),
    idempotencyKey,
  }
  if (paymentMethod.value === 'CARD_ONLINE') {
    return {
      ...body,
      cardToken: cardData.value?.token,
      cardPaymentMethodId: cardData.value?.payment_method_id,
      installments: 1,
    }
  }
  return body
}

function destroyCardBrick() {
  destroyBrick?.()
  destroyBrick = null
}

async function mountBrickIfReady() {
  if (paymentMethod.value !== 'CARD_ONLINE' || !quote.value || quote.value.problems.length > 0) return
  await nextTick()
  destroyBrick = await mountCardBrick('mp-card-brick', quote.value.totalCents / 100, async (data) => {
    cardData.value = data
    await submit()
  })
}

async function loadAddresses() {
  addresses.value = await api<Address[]>('/me/addresses')
  if (!addressId.value && addresses.value[0]) addressId.value = addresses.value[0].id
}

async function refreshQuote() {
  quote.value = null
  error.value = ''
  if (cart.isEmpty) return
  if (fulfillment.value === 'DELIVERY' && !addressId.value) return
  try {
    quote.value = await api<Quote>('/orders/quote', { method: 'POST', body: JSON.stringify(checkoutBody()) })
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Erro na cotação'
  }
}

onMounted(async () => {
  if (cart.isEmpty) {
    await router.replace('/')
    return
  }
  await loadAddresses().catch(() => {})
  await refreshQuote()
})
watch([fulfillment, addressId], refreshQuote)
watch([paymentMethod, quote], async () => {
  destroyCardBrick()
  cardData.value = null
  await mountBrickIfReady()
})
onBeforeUnmount(destroyCardBrick)

async function saveNewAddress() {
  error.value = ''
  try {
    const created = await api<Address>('/me/addresses', {
      method: 'POST',
      body: JSON.stringify({
        label: newAddr.label || undefined,
        addressText: newAddr.addressText,
        reference: newAddr.reference || undefined,
        lat: newAddr.lat,
        lng: newAddr.lng,
      }),
    })
    showNewAddress.value = false
    await loadAddresses()
    addressId.value = created.id
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Erro ao salvar endereço'
  }
}

const canSubmit = computed(() => Boolean(quote.value && quote.value.problems.length === 0 && !submitting.value))

function hasRequiredPaymentDetails() {
  if (paymentMethod.value === 'CARD_ONLINE' && !cardData.value) {
    error.value = 'Preencha os dados do cartão'
    return false
  }
  return true
}

async function placeOrder() {
  if (!canSubmit.value || !hasRequiredPaymentDetails()) return
  submitting.value = true
  error.value = ''
  try {
    const r = await api<{ order: { id: string }; payment: unknown | null }>('/orders', {
      method: 'POST',
      body: JSON.stringify(checkoutBody()),
    })
    cart.clear()
    await router.replace(`/pedido/${r.order.id}`)
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Erro ao enviar pedido'
    if (paymentMethod.value === 'CARD_ONLINE') {
      cardData.value = null
      destroyCardBrick()
      await mountBrickIfReady()
    }
  } finally {
    submitting.value = false
  }
}

async function submit() {
  if (!canSubmit.value || !hasRequiredPaymentDetails()) return
  if (auth.user?.role === 'CUSTOMER' && !auth.user.phone && !contactPromptHandled.value) {
    showContactPrompt.value = true
    return
  }
  await placeOrder()
}

async function continueWithoutContact() {
  if (savingContact.value || submitting.value) return
  contactPromptHandled.value = true
  showContactPrompt.value = false
  await placeOrder()
}

async function saveContactAndContinue() {
  if (savingContact.value || submitting.value) return
  if (!contactPhone.value.trim()) {
    contactWarning.value = 'Informe um telefone ou continue sem cadastrar.'
    return
  }
  savingContact.value = true
  contactWarning.value = ''
  try {
    await auth.updateContactPhone(contactPhone.value)
    contactPromptHandled.value = true
    showContactPrompt.value = false
    await placeOrder()
  } catch (e) {
    contactWarning.value = e instanceof Error ? e.message : 'Não foi possível salvar o telefone.'
  } finally {
    savingContact.value = false
  }
}
</script>

<template>
  <main class="mx-auto max-w-lg space-y-4 p-4">
    <h1 class="text-xl font-bold">Finalizar pedido — {{ cart.storeName }}</h1>

    <section class="rounded border p-3">
      <ul class="space-y-1 text-sm">
        <li v-for="i in cart.items" :key="i.uid" class="flex justify-between">
          <span>{{ i.quantity }}× {{ i.name }} <span class="text-gray-500">{{ i.optionLabels.join(', ') }}</span></span>
          <span class="flex items-center gap-2">
            {{ formatBRL(i.unitPriceCents * i.quantity) }}
            <button class="text-red-600" @click="cart.removeItem(i.uid)">×</button>
          </span>
        </li>
      </ul>
    </section>

    <section class="space-y-2">
      <label class="flex items-center gap-2"><input v-model="fulfillment" type="radio" value="DELIVERY" /> Entrega</label>
      <label class="flex items-center gap-2"><input v-model="fulfillment" type="radio" value="PICKUP" /> Retirada no balcão</label>
    </section>

    <section v-if="fulfillment === 'DELIVERY'" class="space-y-2 rounded border p-3">
      <p class="font-semibold">Endereço</p>
      <label v-for="a in addresses" :key="a.id" class="flex items-start gap-2 text-sm">
        <input v-model="addressId" type="radio" :value="a.id" class="mt-1" />
        <span>
          {{ a.label ? a.label + ' — ' : '' }}{{ a.addressText }}<em v-if="a.reference" class="text-gray-500"> ({{ a.reference }})</em>
        </span>
      </label>
      <button class="rounded border px-2 py-1 text-sm" @click="showNewAddress = !showNewAddress">
        {{ showNewAddress ? 'Fechar' : '+ novo endereço' }}
      </button>
      <div v-if="showNewAddress" class="space-y-2">
        <input v-model="newAddr.label" placeholder="Apelido (Casa, Trabalho…)" class="w-full rounded border p-2" />
        <input v-model="newAddr.addressText" required placeholder="Rua, número - bairro" class="w-full rounded border p-2" />
        <input v-model="newAddr.reference" placeholder="Referência (opcional)" class="w-full rounded border p-2" />
        <p class="text-xs text-gray-500">Arraste o pino até sua casa:</p>
        <MapPicker :lat="newAddr.lat" :lng="newAddr.lng" @update="({ lat, lng }) => Object.assign(newAddr, { lat, lng })" />
        <button class="w-full rounded border p-2" @click="saveNewAddress">Salvar endereço</button>
      </div>
    </section>

    <section class="space-y-2 rounded border p-3">
      <p class="font-semibold">Pagamento</p>
      <label class="flex items-center gap-2"><input v-model="paymentMethod" type="radio" value="CASH" /> Dinheiro</label>
      <input v-if="paymentMethod === 'CASH'" v-model="changeFor" placeholder="Troco para quanto? (R$, opcional)" class="w-full rounded border p-2" />
      <label class="flex items-center gap-2"><input v-model="paymentMethod" type="radio" value="CARD_MACHINE" /> Maquininha (cartão)</label>
      <label class="flex items-center gap-2"><input v-model="paymentMethod" type="radio" value="PIX_ONLINE" /> PIX (pague agora)</label>
      <label v-if="cardAvailable" class="flex items-center gap-2">
        <input v-model="paymentMethod" type="radio" value="CARD_ONLINE" /> Cartão de crédito (online)
      </label>
      <div v-show="paymentMethod === 'CARD_ONLINE'" id="mp-card-brick" class="mt-2"></div>
    </section>

    <input v-model="taxId" placeholder="CPF/CNPJ na nota (opcional)" class="w-full rounded border p-2" />
    <textarea v-model="note" placeholder="Observações do pedido (opcional)" class="w-full rounded border p-2"></textarea>

    <section v-if="showContactPrompt" data-testid="contact-prompt" class="space-y-2 rounded border border-blue-200 bg-blue-50 p-3">
      <p class="font-semibold">Deseja cadastrar um telefone para contato?</p>
      <p class="text-sm text-gray-600">Opcional. A loja poderá usar este número se precisar falar sobre o pedido.</p>
      <input
        v-model="contactPhone"
        data-testid="contact-phone"
        type="tel"
        autocomplete="tel"
        placeholder="(44) 99999-8888"
        class="w-full rounded border p-2"
      />
      <p v-if="contactWarning" class="text-sm text-amber-700">{{ contactWarning }}</p>
      <div class="flex gap-2">
        <button type="button" :disabled="savingContact || submitting" class="flex-1 rounded border p-2 disabled:opacity-50" @click="continueWithoutContact">
          {{ contactWarning ? 'Continuar sem telefone' : 'Agora não' }}
        </button>
        <button type="button" :disabled="savingContact || submitting" class="flex-1 rounded bg-blue-700 p-2 text-white disabled:opacity-50" @click="saveContactAndContinue">
          {{ savingContact ? 'Salvando…' : 'Salvar telefone e continuar' }}
        </button>
      </div>
    </section>

    <section v-if="quote" class="rounded border p-3 text-sm">
      <p class="flex justify-between"><span>Subtotal</span><span>{{ formatBRL(quote.subtotalCents) }}</span></p>
      <p v-if="fulfillment === 'DELIVERY'" class="flex justify-between">
        <span>Entrega</span><span>{{ quote.deliveryFeeCents != null ? formatBRL(quote.deliveryFeeCents) : '—' }}</span>
      </p>
      <p class="flex justify-between font-bold"><span>Total</span><span>{{ formatBRL(quote.totalCents) }}</span></p>
      <p v-for="p in quote.problems" :key="p" class="mt-1 text-red-600">{{ p }}</p>
    </section>

    <p v-if="error" class="text-sm text-red-600">{{ error }}</p>
    <button
      v-if="paymentMethod !== 'CARD_ONLINE'"
      :disabled="!canSubmit"
      class="w-full rounded bg-black p-3 font-semibold text-white disabled:opacity-50"
      @click="submit"
    >
      {{ submitting ? 'Enviando…' : 'Confirmar pedido' }}
    </button>
  </main>
</template>
