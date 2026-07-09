<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { api } from '../lib/api'
import { enablePush, pushConfigured } from '../lib/push'
import { useAuthStore } from '../stores/auth'

const auth = useAuthStore()
const router = useRouter()
const isAvailable = ref(false)
const saving = ref(false)
const showPushButton = ref(pushConfigured())

onMounted(async () => {
  try {
    const me = await api<{ isAvailable: boolean }>('/driver/me')
    isAvailable.value = me.isAvailable
  } catch {
    // token invalido: guard resolve na proxima navegacao.
  }
})

async function toggle() {
  saving.value = true
  try {
    const r = await api<{ isAvailable: boolean }>('/driver/me/availability', {
      method: 'PATCH',
      body: JSON.stringify({ isAvailable: !isAvailable.value }),
    })
    isAvailable.value = r.isAvailable
  } finally {
    saving.value = false
  }
}

async function onEnablePush() {
  const r = await enablePush()
  if (r === 'ok') showPushButton.value = false
}

async function logout() {
  await auth.logout()
  await router.replace('/login')
}
</script>

<template>
  <div class="min-h-screen">
    <header class="flex items-center justify-between border-b p-3">
      <nav class="flex gap-3 text-sm">
        <RouterLink to="/" class="underline">Disponíveis</RouterLink>
        <RouterLink to="/entregas" class="underline">Minhas entregas</RouterLink>
      </nav>
      <div class="flex items-center gap-2">
        <button v-if="showPushButton" class="text-sm underline" @click="onEnablePush">🔔 Ativar alertas</button>
        <button
          :disabled="saving"
          class="rounded-full px-3 py-1 text-sm font-semibold"
          :class="isAvailable ? 'bg-green-600 text-white' : 'bg-gray-300'"
          @click="toggle"
        >
          {{ isAvailable ? 'Disponível' : 'Indisponível' }}
        </button>
        <button class="text-sm underline" @click="logout">Sair</button>
      </div>
    </header>
    <RouterView />
  </div>
</template>
