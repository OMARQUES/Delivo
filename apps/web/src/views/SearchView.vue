<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { formatBRL } from '@delivery/shared/constants'
import { api } from '../lib/api'

type Result = {
  store: { id: string; name: string; slug: string; logoKey: string | null }
  products: { id: string; name: string; priceCents: number; photoKey: string | null }[]
}

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:8787'
const route = useRoute()
const router = useRouter()
const q = ref((route.query.q as string) ?? '')
const results = ref<Result[]>([])
const loading = ref(false)

async function search() {
  if (q.value.trim().length < 2) {
    results.value = []
    return
  }
  loading.value = true
  try {
    results.value = await api<Result[]>(`/search?q=${encodeURIComponent(q.value)}`)
  } finally {
    loading.value = false
  }
}

function submit() {
  router.replace({ name: 'search', query: { q: q.value } })
  search()
}

onMounted(search)
watch(() => route.query.q, (v) => { q.value = (v as string) ?? ''; search() })
</script>

<template>
  <main class="mx-auto max-w-lg p-4">
    <form class="flex gap-2" @submit.prevent="submit">
      <input v-model="q" placeholder="Buscar produto em todas as lojas…" class="flex-1 rounded border p-2" />
      <button class="rounded bg-black px-3 text-white">Buscar</button>
    </form>
    <p v-if="loading" class="mt-4 text-gray-500">Buscando…</p>
    <p v-else-if="q.length >= 2 && results.length === 0" class="mt-4 text-gray-500">Nada encontrado.</p>
    <section v-for="r in results" :key="r.store.id" class="mt-4 rounded border">
      <RouterLink :to="`/${r.store.slug}`" class="flex items-center gap-2 border-b bg-gray-50 p-2 font-semibold">
        <img v-if="r.store.logoKey" :src="`${API_URL}/media/${r.store.logoKey}`" class="h-8 w-8 rounded object-cover" alt="" />
        {{ r.store.name }}
      </RouterLink>
      <ul class="divide-y">
        <li v-for="p in r.products" :key="p.id" class="flex items-center gap-2 p-2">
          <img v-if="p.photoKey" :src="`${API_URL}/media/${p.photoKey}`" class="h-10 w-10 rounded object-cover" alt="" />
          <span class="flex-1">{{ p.name }}</span>
          <span class="text-sm">{{ formatBRL(p.priceCents) }}</span>
        </li>
      </ul>
    </section>
  </main>
</template>
