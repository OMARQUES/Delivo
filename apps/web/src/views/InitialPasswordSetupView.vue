<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import type { ApiError } from '../lib/api'
import { useAuthStore } from '../stores/auth'

const auth = useAuthStore()
const router = useRouter()
const password = ref('')
const confirmation = ref('')
const loading = ref(false)
const redirecting = ref(false)
const success = ref(false)
const error = ref('')

const canSubmit = computed(() => (
  password.value.length >= 15
  && password.value.length <= 128
  && password.value === confirmation.value
  && !loading.value
))

function activeTicket(): string | null {
  const expiry = auth.passwordSetupExpiresAt
    ? Date.parse(auth.passwordSetupExpiresAt)
    : Number.NaN
  if (!auth.passwordSetupTicket || !Number.isFinite(expiry) || expiry <= Date.now()) return null
  return auth.passwordSetupTicket
}

async function returnToGuidance() {
  redirecting.value = true
  auth.clearPasswordSetup()
  await router.replace({
    name: 'verify-email',
    query: { reason: 'password-setup-lost' },
  })
}

async function submit() {
  if (!activeTicket()) {
    await returnToGuidance()
    return
  }
  if (!canSubmit.value) return
  loading.value = true
  error.value = ''
  try {
    await auth.setupInitialPassword(password.value)
    password.value = ''
    confirmation.value = ''
    success.value = true
  } catch (cause) {
    if ((cause as Partial<ApiError>).code === 'FLOW_INVALID_OR_EXPIRED') {
      await returnToGuidance()
      return
    }
    error.value = cause instanceof Error ? cause.message : 'Não foi possível ativar a conta.'
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  if (!activeTicket()) void returnToGuidance()
})
</script>

<template>
  <main class="mx-auto max-w-sm p-4">
    <h1 class="text-2xl font-bold">Criar senha da loja</h1>
    <template v-if="success">
      <p class="mt-3 text-green-700">Conta ativada. Entre com sua nova senha.</p>
      <RouterLink data-testid="router-link" to="/login" class="mt-4 block text-center underline">
        Ir para o login
      </RouterLink>
    </template>
    <form v-else-if="!redirecting && auth.passwordSetupTicket" class="mt-4 space-y-3" @submit.prevent="submit">
      <p class="text-sm text-gray-600">Use de 15 a 128 caracteres. Senhas comuns não são aceitas.</p>
      <input
        v-model="password"
        type="password"
        minlength="15"
        maxlength="128"
        required
        autocomplete="new-password"
        placeholder="Nova senha"
        class="w-full rounded border p-2"
      />
      <input
        v-model="confirmation"
        data-testid="password-confirmation"
        type="password"
        minlength="15"
        maxlength="128"
        required
        autocomplete="new-password"
        placeholder="Repita a nova senha"
        class="w-full rounded border p-2"
      />
      <p v-if="confirmation && password !== confirmation" class="text-sm text-red-600">As senhas não coincidem.</p>
      <p v-if="error" class="text-sm text-red-600">{{ error }}</p>
      <button type="submit" :disabled="!canSubmit" class="w-full rounded bg-black p-2 text-white disabled:opacity-50">
        {{ loading ? 'Ativando…' : 'Ativar conta' }}
      </button>
    </form>
  </main>
</template>
