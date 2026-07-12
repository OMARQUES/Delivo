<script setup lang="ts">
import { computed } from 'vue'
import { useAuthStore } from '../stores/auth'

const auth = useAuthStore()
const user = computed(() => auth.user)

const roleLabel = 'Entregador'
const statusLabel = computed(() =>
  user.value?.status === 'ACTIVE' ? 'Ativo' : user.value?.status === 'PENDING_APPROVAL' ? 'Aguardando aprovação' : 'Bloqueado',
)
</script>

<template>
  <main class="mx-auto max-w-lg space-y-4 p-4">
    <h1 class="text-xl font-bold">Meus dados</h1>
    <div v-if="user" class="divide-y rounded border">
      <div class="flex justify-between p-3">
        <span class="text-gray-500">Nome</span><span class="font-medium">{{ user.name }}</span>
      </div>
      <div class="flex justify-between p-3">
        <span class="text-gray-500">Telefone</span><span class="font-medium">{{ user.phone ?? '—' }}</span>
      </div>
      <div class="flex justify-between p-3">
        <span class="text-gray-500">Email</span><span class="font-medium">{{ user.email ?? '—' }}</span>
      </div>
      <div class="flex justify-between p-3">
        <span class="text-gray-500">Perfil</span><span class="font-medium">{{ roleLabel }}</span>
      </div>
      <div class="flex justify-between p-3">
        <span class="text-gray-500">Situação</span><span class="font-medium">{{ statusLabel }}</span>
      </div>
    </div>
    <p v-else class="text-sm text-gray-500">Sessão não carregada.</p>
    <p class="text-xs text-gray-400">Chave PIX e turno ficam no topo da tela (barra do app).</p>
  </main>
</template>
