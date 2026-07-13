<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import type { ApiError } from '../lib/api'
import TurnstileWidget from '../components/TurnstileWidget.vue'
import {
  clearVerificationTiming,
  deferVerificationResend,
  loadVerificationTiming,
  useAuthStore,
} from '../stores/auth'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const auth = useAuthStore()
const route = useRoute()
const router = useRouter()
const verificationId = ref('')
const code = ref('')
const error = ref('')
const notice = ref('')
const confirmationNotice = ref('')
const confirming = ref(false)
const resending = ref(false)
const turnstileRequired = ref(false)
const turnstileToken = ref<string | null>(null)
const expiresAt = ref<number | null>(null)
const resendAt = ref<number | null>(null)
const codeExpired = ref(false)
const resendAvailable = ref(false)
const now = ref(Date.now())
let timer: number | null = null

const validFlow = computed(() => UUID.test(verificationId.value))
const canConfirm = computed(() => validFlow.value && /^\d{6}$/.test(code.value) && !codeExpired.value && !confirming.value)
const resendRemaining = computed(() => Math.max(0, Math.ceil(((resendAt.value ?? 0) - now.value) / 1000)))
const canResend = computed(() => (
  validFlow.value
  && !confirmationNotice.value
  && resendAvailable.value
  && resendRemaining.value === 0
  && !resending.value
))

function initializeFlow(raw: unknown) {
  code.value = ''
  error.value = ''
  notice.value = ''
  confirmationNotice.value = ''
  turnstileRequired.value = false
  turnstileToken.value = null
  expiresAt.value = null
  resendAt.value = null
  codeExpired.value = false
  resendAvailable.value = false
  verificationId.value = typeof raw === 'string' ? raw : ''
  if (!validFlow.value) {
    error.value = 'Fluxo de verificação inválido.'
    return
  }
  const timing = loadVerificationTiming(verificationId.value)
  resendAvailable.value = timing !== null
  const expiry = timing?.expiresAt ? Date.parse(timing.expiresAt) : Number.NaN
  if (Number.isFinite(expiry) && expiry <= Date.now()) {
    clearVerificationTiming(verificationId.value)
    codeExpired.value = true
    return
  }
  expiresAt.value = Number.isFinite(expiry) ? expiry : null
  const resend = timing?.resendAt ? Date.parse(timing.resendAt) : Number.NaN
  resendAt.value = Number.isFinite(resend) ? resend : null
}

function tick() {
  now.value = Date.now()
  if (expiresAt.value !== null && expiresAt.value <= now.value) {
    clearVerificationTiming(verificationId.value)
    expiresAt.value = null
    resendAt.value = null
    codeExpired.value = true
  }
}

function onCodeInput(event: Event) {
  code.value = (event.target as HTMLInputElement).value.replace(/\D/g, '').slice(0, 6)
}

async function confirm() {
  if (!canConfirm.value) return
  confirming.value = true
  error.value = ''
  try {
    const result = await auth.confirmEmail(verificationId.value, code.value)
    code.value = ''
    if (result.kind === 'CUSTOMER_SESSION') {
      await router.replace('/')
    } else if (result.kind === 'PASSWORD_SETUP_REQUIRED') {
      await router.replace({ name: 'initial-password-setup' })
    } else if (result.kind === 'DRIVER_PENDING_APPROVAL') {
      confirmationNotice.value = 'Email confirmado. Cadastro aguardando aprovação.'
    } else {
      confirmationNotice.value = 'Email confirmado. Entre com sua senha para continuar.'
    }
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : 'Não foi possível confirmar o email.'
    code.value = ''
  } finally {
    confirming.value = false
  }
}

async function resend() {
  if (!canResend.value) return
  resending.value = true
  error.value = ''
  notice.value = ''
  try {
    const flow = await auth.resendEmail(verificationId.value, turnstileToken.value ?? undefined)
    expiresAt.value = Date.parse(flow.expiresAt)
    resendAt.value = Date.parse(flow.resendAt)
    codeExpired.value = false
    code.value = ''
    turnstileRequired.value = false
    turnstileToken.value = null
    notice.value = 'Novo código enviado.'
  } catch (cause) {
    const apiError = cause as Partial<ApiError>
    error.value = cause instanceof Error ? cause.message : 'Não foi possível reenviar o código.'
    if (apiError.code === 'TURNSTILE_REQUIRED') {
      turnstileRequired.value = true
      turnstileToken.value = null
    }
    if (apiError.retryAfter && apiError.retryAfter > 0) {
      resendAt.value = Date.now() + apiError.retryAfter * 1000
      deferVerificationResend(verificationId.value, new Date(resendAt.value).toISOString())
    }
  } finally {
    resending.value = false
  }
}

watch(() => route.query.id, initializeFlow, { immediate: true })
watch(() => route.query.reason, (reason) => {
  if (reason === 'password-setup-lost') {
    error.value = 'A etapa de criação da senha expirou ou foi perdida. Solicite ao administrador um novo email de ativação.'
  }
}, { immediate: true })
onMounted(() => { timer = window.setInterval(tick, 1_000) })
onBeforeUnmount(() => { if (timer !== null) window.clearInterval(timer) })
</script>

<template>
  <main class="mx-auto max-w-sm p-4">
    <h1 class="text-2xl font-bold">Verificar email</h1>
    <p class="mt-2 text-sm text-gray-600">Digite o código numérico de 6 dígitos enviado ao seu email.</p>
    <p v-if="codeExpired" class="mt-3 text-sm text-amber-700">Código expirado. Solicite um novo código.</p>
    <p v-if="confirmationNotice" class="mt-3 text-sm text-green-700">{{ confirmationNotice }}</p>
    <form v-if="!confirmationNotice" class="mt-4 space-y-3" @submit.prevent="confirm">
      <input
        :value="code"
        data-testid="verification-code"
        type="text"
        inputmode="numeric"
        pattern="[0-9]{6}"
        maxlength="6"
        autocomplete="one-time-code"
        required
        class="w-full rounded border p-3 text-center text-2xl tracking-[0.4em]"
        @input="onCodeInput"
      />
      <button type="submit" :disabled="!canConfirm" class="w-full rounded bg-black p-2 text-white disabled:opacity-50">
        {{ confirming ? 'Confirmando…' : 'Confirmar email' }}
      </button>
    </form>
    <p v-if="validFlow && !resendAvailable && !confirmationNotice" class="mt-3 text-xs text-gray-600">
      Se precisar de outro código, solicite um novo envio a quem iniciou sua ativação.
    </p>
    <TurnstileWidget v-if="turnstileRequired && resendAvailable && !confirmationNotice" class="mt-3" action="email_resend" @update:token="turnstileToken = $event" />
    <button
      v-if="resendAvailable && !confirmationNotice"
      data-testid="resend"
      type="button"
      :disabled="!canResend || (turnstileRequired && !turnstileToken)"
      class="mt-3 w-full rounded border p-2 disabled:opacity-50"
      @click="resend"
    >
      {{ resendRemaining > 0 ? `Reenviar em ${resendRemaining}s` : (resending ? 'Reenviando…' : 'Reenviar código') }}
    </button>
    <p v-if="notice" class="mt-3 text-sm text-green-700">{{ notice }}</p>
    <p v-if="error" class="mt-3 text-sm text-red-600">{{ error }}</p>
    <RouterLink to="/login" class="mt-4 block text-center underline">Voltar ao login</RouterLink>
  </main>
</template>
