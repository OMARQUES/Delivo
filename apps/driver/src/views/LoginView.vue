<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '../stores/auth'

const auth = useAuthStore()
const router = useRouter()
const identifier = ref('')
const password = ref('')
const error = ref('')
const loading = ref(false)

async function submit() {
  error.value = ''
  loading.value = true
  try {
    await auth.login(identifier.value, password.value)
    if (auth.role !== 'DRIVER') {
      await auth.logout()
      error.value = 'Esta conta não é de entregador'
      return
    }
    await router.replace('/')
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Erro ao entrar'
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <main class="mx-auto max-w-sm p-4">
    <h1 class="text-2xl font-bold">Entregador - Entrar</h1>
    <form class="mt-4 space-y-3" @submit.prevent="submit">
      <input v-model="identifier" type="text" required placeholder="Telefone (ou email, se cadastrou)" class="w-full rounded border p-2" autocomplete="username" />
      <input v-model="password" type="password" required placeholder="Senha" class="w-full rounded border p-2" autocomplete="current-password" />
      <p v-if="error" class="text-sm text-red-600">{{ error }}</p>
      <button type="submit" :disabled="loading" class="w-full rounded bg-black p-2 font-semibold text-white disabled:opacity-50">
        {{ loading ? 'Entrando...' : 'Entrar' }}
      </button>
    </form>
    <p class="mt-4 text-sm text-gray-600">
      Quer entregar com a gente?
      <RouterLink to="/cadastro" class="underline">Cadastre-se</RouterLink>
    </p>
  </main>
</template>
