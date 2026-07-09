<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { formatBRL, STORE_CATEGORIES } from '@delivery/shared/constants'
import { api } from '../lib/api'
import { useAuthStore } from '../stores/auth'

type PublicStore = {
  id: string; name: string; slug: string; category: string; logoKey: string | null
  isOpen: boolean; minOrderCents: number | null; deliveryEtaMinutes: [number, number] | null
}

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:8787'
const auth = useAuthStore()
const stores = ref<PublicStore[]>([])
const search = ref('')
const category = ref<string>('')
const loading = ref(true)

onMounted(async () => {
  try {
    stores.value = await api<PublicStore[]>('/stores')
  } finally {
    loading.value = false
  }
})

const filtered = computed(() =>
  stores.value
    .filter((s) => !category.value || s.category === category.value)
    .filter((s) => !search.value || s.name.toLowerCase().includes(search.value.toLowerCase()))
    .sort((a, b) => Number(b.isOpen) - Number(a.isOpen)),
)

</script>

<template>
  <main class="mx-auto max-w-lg p-4">
    <header class="flex items-center justify-between">
      <h1 class="text-2xl font-bold">Lojas da cidade</h1>
      <RouterLink v-if="!auth.isAuthenticated" to="/login" class="text-sm underline">Entrar</RouterLink>
      <span v-else class="flex items-center gap-2">
        <span class="text-sm text-gray-600">Olá, {{ auth.user?.name }}</span>
        <RouterLink to="/pedidos" class="text-sm underline">Meus pedidos</RouterLink>
      </span>
    </header>

    <RouterLink to="/busca" class="mt-3 block rounded border p-2 text-center text-sm text-gray-600">
      🔍 Buscar produto em todas as lojas
    </RouterLink>

    <input v-model="search" placeholder="Buscar loja…" class="mt-3 w-full rounded border p-2" />
    <div class="mt-2 flex flex-wrap gap-1">
      <button class="rounded-full border px-3 py-1 text-xs" :class="!category && 'bg-black text-white'" @click="category = ''">Todas</button>
      <button
        v-for="(label, key) in STORE_CATEGORIES"
        :key="key"
        class="rounded-full border px-3 py-1 text-xs"
        :class="category === key && 'bg-black text-white'"
        @click="category = key"
      >
        {{ label }}
      </button>
    </div>

    <p v-if="loading" class="mt-6 text-gray-500">Carregando…</p>
    <p v-else-if="filtered.length === 0" class="mt-6 text-gray-500">Nenhuma loja encontrada.</p>
    <ul class="mt-4 space-y-2">
      <li v-for="s in filtered" :key="s.id">
        <RouterLink :to="`/${s.slug}`" class="flex items-center gap-3 rounded border p-3" :class="!s.isOpen && 'opacity-50'">
          <img v-if="s.logoKey" :src="`${API_URL}/media/${s.logoKey}`" class="h-12 w-12 rounded object-cover" alt="" />
          <div v-else class="flex h-12 w-12 items-center justify-center rounded bg-gray-200 font-bold">{{ s.name[0] }}</div>
          <div class="flex-1">
            <p class="font-medium">{{ s.name }}</p>
            <p class="text-xs text-gray-500">
              {{ s.isOpen ? 'Aberto' : 'Fechado' }}
              <template v-if="s.deliveryEtaMinutes"> · {{ s.deliveryEtaMinutes[0] }}-{{ s.deliveryEtaMinutes[1] }} min</template>
              <template v-if="s.minOrderCents != null"> · mín {{ formatBRL(s.minOrderCents) }}</template>
            </p>
          </div>
        </RouterLink>
      </li>
    </ul>
  </main>
</template>
