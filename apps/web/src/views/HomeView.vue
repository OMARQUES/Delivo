<script setup lang="ts">
import { useAuthStore } from '../stores/auth'

const auth = useAuthStore()
</script>

<template>
  <main class="mx-auto max-w-lg p-4">
    <header class="flex items-center justify-between">
      <h1 class="text-2xl font-bold">Lojas da cidade</h1>
      <RouterLink v-if="!auth.isAuthenticated" to="/login" class="text-sm underline">Entrar</RouterLink>
      <span v-else class="text-sm text-gray-600">Olá, {{ auth.user?.name }}</span>
    </header>
    <p class="mt-2 text-gray-600">Lista de lojas entra no plano de catálogo.</p>
  </main>
</template>
