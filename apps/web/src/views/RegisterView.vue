<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import TurnstileWidget from '../components/TurnstileWidget.vue'
import { useAuthStore } from '../stores/auth'

const auth = useAuthStore()
const router = useRouter()

const name = ref('')
const phone = ref('')
const email = ref('')
const password = ref('')
const acceptedTerms = ref(false)
const turnstileToken = ref<string | null>(null)
const error = ref('')
const loading = ref(false)

async function submit() {
  error.value = ''
  loading.value = true
  try {
    const flow = await auth.registerCustomer({
      name: name.value,
      phone: phone.value || undefined,
      email: email.value,
      password: password.value,
      acceptedTerms: acceptedTerms.value,
      turnstileToken: turnstileToken.value!,
    })
    await router.replace({ name: 'verify-email', query: { id: flow.verificationId } })
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Erro ao cadastrar'
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <main class="mx-auto max-w-sm p-4">
    <h1 class="text-2xl font-bold">Criar conta</h1>
    <form class="mt-4 space-y-3" @submit.prevent="submit">
      <input v-model="name" type="text" required placeholder="Nome" class="w-full rounded border p-2" autocomplete="name" />
      <input v-model="phone" type="tel" placeholder="WhatsApp (opcional)" class="w-full rounded border p-2" autocomplete="tel" />
      <input v-model="email" type="email" required placeholder="Email" class="w-full rounded border p-2" autocomplete="email" />
      <input v-model="password" type="password" required minlength="8" placeholder="Senha (mín. 8)" class="w-full rounded border p-2" autocomplete="new-password" />
      <label class="flex items-start gap-2 text-sm text-gray-700">
        <input v-model="acceptedTerms" type="checkbox" required class="mt-1" />
        <span>Li e aceito a política de privacidade (LGPD)</span>
      </label>
      <TurnstileWidget action="register" @update:token="turnstileToken = $event" />
      <p v-if="error" class="text-sm text-red-600">{{ error }}</p>
      <button type="submit" :disabled="loading || !turnstileToken" class="w-full rounded bg-black p-2 font-semibold text-white disabled:opacity-50">
        {{ loading ? 'Criando…' : 'Criar conta' }}
      </button>
    </form>
    <p class="mt-4 text-sm text-gray-600">
      Já tem conta?
      <RouterLink to="/login" class="underline">Entrar</RouterLink>
    </p>
  </main>
</template>
