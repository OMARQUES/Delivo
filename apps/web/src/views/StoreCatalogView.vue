<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { api } from '../lib/api'

type PublicStore = {
  name: string; slug: string; category: string; phone: string; addressText: string
  logoKey: string | null; isOpen: boolean
  deliveryEtaMinutes: [number, number] | null; pickupEtaMinutes: [number, number] | null
  minOrderCents: number | null
}

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:8787'
const route = useRoute()
const store = ref<PublicStore | null>(null)
const notFound = ref(false)

async function load(slug: string) {
  notFound.value = false
  store.value = null
  try {
    store.value = await api<PublicStore>(`/stores/${slug}`)
  } catch {
    notFound.value = true
  }
}

onMounted(() => load(route.params.storeSlug as string))
watch(
  () => route.params.storeSlug,
  (s) => typeof s === 'string' && load(s),
)
</script>

<template>
  <main class="mx-auto max-w-lg p-4">
    <p v-if="notFound">
      Loja não encontrada. <RouterLink to="/" class="underline">Ver todas</RouterLink>
    </p>
    <template v-else-if="store">
      <header class="flex items-center gap-3">
        <img v-if="store.logoKey" :src="`${API_URL}/media/${store.logoKey}`" class="h-16 w-16 rounded object-cover" alt="" />
        <div>
          <h1 class="text-2xl font-bold">{{ store.name }}</h1>
          <p class="text-sm" :class="store.isOpen ? 'text-green-700' : 'text-red-600'">
            {{ store.isOpen ? 'Aberto agora' : 'Fechado' }}
          </p>
          <p class="text-xs text-gray-500">
            {{ store.addressText }}
            <template v-if="store.deliveryEtaMinutes"> · entrega {{ store.deliveryEtaMinutes[0] }}-{{ store.deliveryEtaMinutes[1] }} min</template>
          </p>
        </div>
      </header>
      <p class="mt-6 text-gray-600">Cardápio entra no plano de produtos.</p>
    </template>
    <p v-else class="text-gray-500">Carregando…</p>
  </main>
</template>
