<script setup lang="ts">
import { ref } from 'vue'
import { useAuthStore } from '../stores/auth'

const auth = useAuthStore()
const name = ref('')
const phone = ref('')
const email = ref('')
const password = ref('')
const acceptedTerms = ref(false)
const error = ref('')
const done = ref(false)
const loading = ref(false)

async function submit() {
  error.value = ''
  loading.value = true
  try {
    await auth.register({
      name: name.value,
      phone: phone.value,
      email: email.value || undefined,
      password: password.value,
      acceptedTerms: acceptedTerms.value,
      role: 'DRIVER',
    })
    done.value = true
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Erro ao cadastrar'
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <main class="mx-auto max-w-sm p-4">
    <template v-if="done">
      <h1 class="text-2xl font-bold">Cadastro enviado!</h1>
      <p class="mt-2 text-gray-600">Seu cadastro está aguardando aprovação do administrador. Você será liberado em breve.</p>
      <RouterLink to="/login" class="mt-4 block text-center underline">Voltar ao login</RouterLink>
    </template>
    <template v-else>
      <h1 class="text-2xl font-bold">Cadastro de entregador</h1>
      <form class="mt-4 space-y-3" @submit.prevent="submit">
        <input v-model="name" required placeholder="Nome completo" class="w-full rounded border p-2" />
        <input v-model="phone" type="tel" required placeholder="WhatsApp (44) 99999-9999" class="w-full rounded border p-2" />
        <input v-model="email" type="email" placeholder="Email (opcional — permite login por email)" class="w-full rounded border p-2" autocomplete="email" />
        <input v-model="password" type="password" required minlength="8" placeholder="Senha (min. 8)" class="w-full rounded border p-2" />
        <label class="flex items-start gap-2 text-sm text-gray-700">
          <input v-model="acceptedTerms" type="checkbox" required class="mt-1" />
          <span>Li e aceito a política de privacidade (LGPD)</span>
        </label>
        <p v-if="error" class="text-sm text-red-600">{{ error }}</p>
        <button type="submit" :disabled="loading" class="w-full rounded bg-black p-2 font-semibold text-white disabled:opacity-50">
          {{ loading ? 'Enviando...' : 'Cadastrar' }}
        </button>
      </form>
    </template>
  </main>
</template>
