<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useRecoveryStore } from '../stores/recovery'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const recovery = useRecoveryStore()
const route = useRoute()
const router = useRouter()
const recoveryId = typeof route.query.id === 'string' ? route.query.id : ''
const code = ref('')
const loading = ref(false)
const error = ref(UUID.test(recoveryId) ? '' : 'Fluxo inválido ou expirado.')
const canSubmit = computed(() => UUID.test(recoveryId) && /^\d{6}$/.test(code.value) && !loading.value)

function onCodeInput(event: Event) {
  code.value = (event.target as HTMLInputElement).value.replace(/\D/g, '').slice(0, 6)
}

async function submit() {
  if (!canSubmit.value) return
  loading.value = true
  error.value = ''
  try {
    await recovery.verify(recoveryId, code.value)
    await router.push({ name: 'recovery-reset' })
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : 'Código inválido ou expirado.'
    code.value = ''
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <main class="mx-auto max-w-sm p-4">
    <h1 class="text-2xl font-bold">Digite o código</h1>
    <p class="mt-2 text-sm text-gray-600">Informe o código numérico de 6 dígitos enviado ao email.</p>
    <form v-if="UUID.test(recoveryId)" class="mt-4 space-y-3" @submit.prevent="submit">
      <input
        :value="code"
        data-testid="recovery-code"
        type="text"
        inputmode="numeric"
        pattern="[0-9]{6}"
        maxlength="6"
        autocomplete="one-time-code"
        required
        class="w-full rounded border p-3 text-center text-2xl tracking-[0.4em]"
        @input="onCodeInput"
      />
      <button
        type="submit"
        :disabled="!canSubmit"
        class="w-full rounded bg-black p-2 text-white disabled:opacity-50"
      >
        {{ loading ? 'Verificando…' : 'Continuar' }}
      </button>
    </form>
    <p v-if="error" class="mt-3 text-sm text-red-600">{{ error }}</p>
    <RouterLink to="/recuperar-senha" class="mt-4 block text-center underline">Iniciar novamente</RouterLink>
  </main>
</template>
