<script setup lang="ts">
import { ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import TurnstileWidget from '../components/TurnstileWidget.vue'
import { useRecoveryStore } from '../stores/recovery'

const recovery = useRecoveryStore()
const route = useRoute()
const router = useRouter()
const email = ref('')
const turnstileToken = ref<string | null>(null)
const turnstile = ref<{ reset: () => void } | null>(null)
const loading = ref(false)
const error = ref('')
const flowLost = route.query.reason === 'flow-lost'

async function submit() {
  if (!turnstileToken.value || loading.value) return
  loading.value = true
  error.value = ''
  try {
    const flow = await recovery.start(email.value, turnstileToken.value)
    await router.push({ name: 'recovery-verify', query: { id: flow.recoveryId } })
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : 'Não foi possível iniciar a recuperação de senha.'
    turnstileToken.value = null
    turnstile.value?.reset()
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <main class="mx-auto max-w-sm p-4">
    <h1 class="text-2xl font-bold">Recuperar senha</h1>
    <p class="mt-2 text-sm text-gray-600">
      Se existir uma conta elegível para este email, enviaremos um código numérico de 6 dígitos.
    </p>
    <p v-if="flowLost" class="mt-3 text-sm text-amber-700">
      Para sua segurança, inicie novamente a recuperação de senha.
    </p>
    <form class="mt-4 space-y-3" @submit.prevent="submit">
      <input
        v-model="email"
        type="email"
        required
        maxlength="254"
        autocomplete="email"
        placeholder="Email"
        class="w-full rounded border p-2"
      />
      <TurnstileWidget
        ref="turnstile"
        action="password_recovery"
        @update:token="turnstileToken = $event"
      />
      <p v-if="error" class="text-sm text-red-600">{{ error }}</p>
      <button
        type="submit"
        :disabled="loading || !turnstileToken"
        class="w-full rounded bg-black p-2 font-semibold text-white disabled:opacity-50"
      >
        {{ loading ? 'Enviando…' : 'Enviar código' }}
      </button>
    </form>
    <RouterLink to="/login" class="mt-4 block text-center underline">Voltar ao login</RouterLink>
  </main>
</template>
