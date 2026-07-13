<script setup lang="ts">
import { onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { STORE_CATEGORIES, slugify } from '@delivery/shared/constants'
import TurnstileWidget from '../../components/TurnstileWidget.vue'
import { api, type ApiError } from '../../lib/api'

type StoreSecurityStatus = 'ACTIVE' | 'SUSPENDED' | 'CLOSED' | 'PENDING_ACTIVATION'
type AdminStore = {
  id: string
  name: string
  slug: string
  category: string
  securityStatus: StoreSecurityStatus
  commissionBps: number
}
type VerificationTiming = { expiresAt: string; resendAt: string }
type ProvisionResponse = { store: AdminStore; verification: VerificationTiming }

const stores = ref<AdminStore[]>([])
const error = ref('')
const notice = ref('')
const saving = ref(false)
const showForm = ref(false)
const busyStoreId = ref<string | null>(null)
const turnstileStoreId = ref<string | null>(null)
const turnstileToken = ref<string | null>(null)
const now = ref(Date.now())
const activationTiming = reactive<Record<string, { expiresAt: number; resendAt: number }>>({})
let timer: number | null = null

const form = reactive({
  name: '',
  slug: '',
  category: 'PIZZARIA',
  phone: '',
  city: '',
  addressText: '',
  lat: -23.5,
  lng: -51.9,
  owner: { name: '', email: '' },
})

const statusLabels: Record<StoreSecurityStatus, string> = {
  ACTIVE: 'Ativa',
  SUSPENDED: 'Suspensa',
  CLOSED: 'Encerrada',
  PENDING_ACTIVATION: 'Aguardando ativação',
}

async function load() {
  stores.value = await api<AdminStore[]>('/admin/stores')
}

function rememberTiming(storeId: string, timing: VerificationTiming) {
  const expiresAt = Date.parse(timing.expiresAt)
  const resendAt = Date.parse(timing.resendAt)
  if (!Number.isFinite(expiresAt) || !Number.isFinite(resendAt)) return
  activationTiming[storeId] = { expiresAt, resendAt }
}

function resendRemaining(storeId: string): number {
  return Math.max(0, Math.ceil(((activationTiming[storeId]?.resendAt ?? 0) - now.value) / 1000))
}

onMounted(() => {
  void load().catch((cause) => {
    error.value = cause instanceof Error ? cause.message : 'Não foi possível carregar as lojas.'
  })
  timer = window.setInterval(() => { now.value = Date.now() }, 1_000)
})
onBeforeUnmount(() => { if (timer !== null) window.clearInterval(timer) })

function suggestSlug() {
  if (!form.slug) form.slug = slugify(form.name)
}

async function createStore() {
  error.value = ''
  notice.value = ''
  saving.value = true
  try {
    const result = await api<ProvisionResponse>('/admin/stores', {
      method: 'POST',
      body: JSON.stringify(form),
    })
    rememberTiming(result.store.id, result.verification)
    showForm.value = false
    Object.assign(form, {
      name: '',
      slug: '',
      phone: '',
      addressText: '',
      owner: { name: '', email: '' },
    })
    notice.value = 'Loja criada. Email de ativação enviado ao proprietário.'
    await load()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : 'Não foi possível criar a loja.'
  } finally {
    saving.value = false
  }
}

async function resendActivation(store: AdminStore) {
  if (
    store.securityStatus !== 'PENDING_ACTIVATION'
    || busyStoreId.value
    || resendRemaining(store.id) > 0
  ) return
  busyStoreId.value = store.id
  error.value = ''
  notice.value = ''
  try {
    const proof = turnstileStoreId.value === store.id ? turnstileToken.value : null
    const timing = await api<VerificationTiming>(`/admin/stores/${store.id}/activation/resend`, {
      method: 'POST',
      body: JSON.stringify(proof ? { turnstileToken: proof } : {}),
    })
    rememberTiming(store.id, timing)
    turnstileStoreId.value = null
    turnstileToken.value = null
    notice.value = 'Novo email de ativação enviado.'
  } catch (cause) {
    const apiError = cause as Partial<ApiError>
    error.value = cause instanceof Error ? cause.message : 'Não foi possível reenviar a ativação.'
    if (apiError.code === 'TURNSTILE_REQUIRED') {
      turnstileStoreId.value = store.id
      turnstileToken.value = null
    }
    if (apiError.retryAfter && apiError.retryAfter > 0) {
      activationTiming[store.id] = {
        expiresAt: activationTiming[store.id]?.expiresAt ?? 0,
        resendAt: Date.now() + apiError.retryAfter * 1_000,
      }
    }
  } finally {
    busyStoreId.value = null
  }
}

async function toggleSecurityStatus(store: AdminStore) {
  if (store.securityStatus !== 'ACTIVE' && store.securityStatus !== 'SUSPENDED') return
  busyStoreId.value = store.id
  error.value = ''
  try {
    await api(`/admin/stores/${store.id}/security-status`, {
      method: 'PATCH',
      body: JSON.stringify({
        securityStatus: store.securityStatus === 'ACTIVE' ? 'SUSPENDED' : 'ACTIVE',
      }),
    })
    await load()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : 'Não foi possível alterar a loja.'
  } finally {
    busyStoreId.value = null
  }
}

async function saveCommission(store: AdminStore, percentStr: string) {
  if (store.securityStatus !== 'ACTIVE') return
  const percent = Number(percentStr)
  if (Number.isNaN(percent) || percent < 0 || percent > 100) {
    error.value = 'Comissão deve ser 0–100%'
    return
  }
  busyStoreId.value = store.id
  error.value = ''
  try {
    await api(`/admin/stores/${store.id}/commission`, {
      method: 'PATCH',
      body: JSON.stringify({ commissionBps: Math.round(percent * 100) }),
    })
    await load()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : 'Não foi possível alterar a comissão.'
  } finally {
    busyStoreId.value = null
  }
}
</script>

<template>
  <main class="mx-auto max-w-2xl p-4">
    <div class="flex items-center justify-between">
      <h1 class="text-xl font-bold">Lojas</h1>
      <button class="rounded bg-black px-3 py-1 text-white" @click="showForm = !showForm">
        {{ showForm ? 'Fechar' : 'Nova loja' }}
      </button>
    </div>
    <p v-if="error" class="mt-2 text-sm text-red-600">{{ error }}</p>
    <p v-if="notice" class="mt-2 text-sm text-green-700">{{ notice }}</p>

    <form v-if="showForm" class="mt-4 space-y-2 rounded border p-4" @submit.prevent="createStore">
      <input v-model="form.name" required placeholder="Nome da loja" class="w-full rounded border p-2" @blur="suggestSlug" />
      <input v-model="form.slug" required placeholder="slug-da-loja" class="w-full rounded border p-2" />
      <select v-model="form.category" class="w-full rounded border p-2">
        <option v-for="(label, key) in STORE_CATEGORIES" :key="key" :value="key">{{ label }}</option>
      </select>
      <input v-model="form.phone" required placeholder="WhatsApp da loja" class="w-full rounded border p-2" />
      <input v-model="form.city" required placeholder="Cidade" class="w-full rounded border p-2" />
      <input v-model="form.addressText" required placeholder="Endereço" class="w-full rounded border p-2" />
      <div class="grid grid-cols-2 gap-2">
        <input v-model.number="form.lat" type="number" step="any" required placeholder="Lat" class="rounded border p-2" />
        <input v-model.number="form.lng" type="number" step="any" required placeholder="Lng" class="rounded border p-2" />
      </div>
      <p class="pt-2 text-sm font-semibold">Proprietário</p>
      <p class="text-xs text-gray-600">O proprietário receberá um email para confirmar a conta e criar a própria senha.</p>
      <input v-model="form.owner.name" required placeholder="Nome do dono" class="w-full rounded border p-2" autocomplete="name" />
      <input v-model="form.owner.email" type="email" required placeholder="Email de login" class="w-full rounded border p-2" autocomplete="email" />
      <button type="submit" :disabled="saving" class="w-full rounded bg-black p-2 text-white disabled:opacity-50">
        {{ saving ? 'Criando…' : 'Criar loja' }}
      </button>
    </form>

    <ul class="mt-4 divide-y rounded border">
      <li v-for="store in stores" :key="store.id" class="flex items-start justify-between gap-3 p-3">
        <div class="min-w-0 flex-1">
          <p class="font-medium">{{ store.name }} <span class="text-xs text-gray-500">/{{ store.slug }}</span></p>
          <p class="text-xs text-gray-500">{{ store.category }} · {{ statusLabels[store.securityStatus] }}</p>
          <label class="mt-1 flex items-center gap-1 text-xs text-gray-600">
            Comissão:
            <input
              data-testid="commission"
              type="number"
              min="0"
              max="100"
              step="0.5"
              :disabled="store.securityStatus !== 'ACTIVE' || busyStoreId === store.id"
              :value="(store.commissionBps / 100).toString()"
              class="w-16 rounded border p-1 disabled:bg-gray-100"
              @change="saveCommission(store, ($event.target as HTMLInputElement).value)"
            /> %
          </label>

          <div v-if="store.securityStatus === 'PENDING_ACTIVATION'" class="mt-2 space-y-2">
            <button
              data-testid="activation-resend"
              type="button"
              :disabled="busyStoreId === store.id || resendRemaining(store.id) > 0 || (turnstileStoreId === store.id && !turnstileToken)"
              class="rounded border px-2 py-1 text-sm disabled:opacity-50"
              @click="resendActivation(store)"
            >
              {{ resendRemaining(store.id) > 0 ? `Reenviar em ${resendRemaining(store.id)}s` : (busyStoreId === store.id ? 'Reenviando…' : 'Reenviar ativação') }}
            </button>
            <TurnstileWidget
              v-if="turnstileStoreId === store.id"
              action="email_resend"
              @update:token="turnstileToken = $event"
            />
          </div>
        </div>

        <button
          v-if="store.securityStatus === 'ACTIVE' || store.securityStatus === 'SUSPENDED'"
          data-testid="security-status-action"
          type="button"
          :disabled="busyStoreId === store.id"
          class="rounded border px-2 py-1 text-sm disabled:opacity-50"
          @click="toggleSecurityStatus(store)"
        >
          {{ store.securityStatus === 'ACTIVE' ? 'Suspender' : 'Reativar' }}
        </button>
      </li>
    </ul>
  </main>
</template>
