<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import type { ApiError } from '../lib/api'
import { useRecoveryStore } from '../stores/recovery'

const recovery = useRecoveryStore()
const router = useRouter()
const password = ref('')
const confirmation = ref('')
const loading = ref(false)
const redirecting = ref(false)
const success = ref(false)
const error = ref('')
const canSubmit = computed(() => (
  password.value.length >= 8
  && password.value.length <= 128
  && password.value === confirmation.value
  && !loading.value
))

function activeTicket(): string | null {
  const expiry = recovery.resetExpiresAt ? Date.parse(recovery.resetExpiresAt) : Number.NaN
  if (!recovery.resetTicket || !Number.isFinite(expiry) || expiry <= Date.now()) return null
  return recovery.resetTicket
}

async function returnToStart() {
  redirecting.value = true
  recovery.clear()
  await router.replace({ name: 'recovery-start', query: { reason: 'flow-lost' } })
}

async function submit() {
  const ticket = activeTicket()
  if (!ticket) {
    await returnToStart()
    return
  }
  if (!canSubmit.value) return
  loading.value = true
  error.value = ''
  try {
    await recovery.reset(ticket, password.value)
    password.value = ''
    confirmation.value = ''
    success.value = true
  } catch (cause) {
    if ((cause as Partial<ApiError>).code === 'FLOW_INVALID_OR_EXPIRED') {
      await returnToStart()
      return
    }
    error.value = cause instanceof Error ? cause.message : 'Não foi possível alterar a senha.'
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  if (!activeTicket()) void returnToStart()
})
</script>

<template>
  <main class="mx-auto max-w-sm p-4">
    <h1 class="text-2xl font-bold">Criar nova senha</h1>
    <template v-if="success">
      <p class="mt-3 text-green-700">Senha alterada. Entre novamente com sua nova senha.</p>
      <RouterLink data-testid="router-link" to="/login" class="mt-4 block text-center underline">
        Ir para o login
      </RouterLink>
    </template>
    <form v-else-if="!redirecting && recovery.resetTicket" class="mt-4 space-y-3" @submit.prevent="submit">
      <p class="text-sm text-gray-600">
        Use de 8 a 128 caracteres. Algumas contas exigem no mínimo 15; usar 15 ou mais funciona para todas. Senhas comuns não são aceitas.
      </p>
      <input
        v-model="password"
        type="password"
        minlength="8"
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
        minlength="8"
        maxlength="128"
        required
        autocomplete="new-password"
        placeholder="Repita a nova senha"
        class="w-full rounded border p-2"
      />
      <p v-if="confirmation && password !== confirmation" class="text-sm text-red-600">As senhas não coincidem.</p>
      <p v-if="error" class="text-sm text-red-600">{{ error }}</p>
      <button
        type="submit"
        :disabled="!canSubmit"
        class="w-full rounded bg-black p-2 text-white disabled:opacity-50"
      >
        {{ loading ? 'Alterando…' : 'Alterar senha' }}
      </button>
    </form>
  </main>
</template>
