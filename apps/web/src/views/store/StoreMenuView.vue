<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { formatBRL } from '@delivery/shared/constants'
import { api } from '../../lib/api'

type Product = { id: string; name: string; basePriceCents: number; isAvailable: boolean; sortIndex: number }
type Category = { id: string; name: string; sortIndex: number; products: Product[] }

const catalog = ref<Category[]>([])
const newCategory = ref('')
const error = ref('')

async function load() {
  catalog.value = await api<Category[]>('/store/me/catalog')
}
onMounted(() => load().catch((e) => (error.value = e.message)))

async function run(fn: () => Promise<unknown>) {
  error.value = ''
  try {
    await fn()
    await load()
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Erro'
  }
}

const addCategory = () =>
  run(async () => {
    await api('/store/me/categories', { method: 'POST', body: JSON.stringify({ name: newCategory.value }) })
    newCategory.value = ''
  })
const renameCategory = (c: Category) => {
  const name = prompt('Novo nome', c.name)
  if (name) run(() => api(`/store/me/categories/${c.id}`, { method: 'PATCH', body: JSON.stringify({ name }) }))
}
const removeCategory = (c: Category) =>
  run(() => api(`/store/me/categories/${c.id}`, { method: 'DELETE' }))
const toggleProduct = (p: Product) =>
  run(() => api(`/store/me/products/${p.id}`, { method: 'PATCH', body: JSON.stringify({ isAvailable: !p.isAvailable }) }))
const removeProduct = (p: Product) =>
  run(() => api(`/store/me/products/${p.id}`, { method: 'DELETE' }))

function swapCategory(i: number, j: number) {
  const a = catalog.value[i], b = catalog.value[j]
  if (!a || !b) return
  run(async () => {
    await api(`/store/me/categories/${a.id}`, { method: 'PATCH', body: JSON.stringify({ sortIndex: j }) })
    await api(`/store/me/categories/${b.id}`, { method: 'PATCH', body: JSON.stringify({ sortIndex: i }) })
  })
}

function swapProduct(c: Category, i: number, j: number) {
  const a = c.products[i], b = c.products[j]
  if (!a || !b) return
  run(async () => {
    await api(`/store/me/products/${a.id}`, { method: 'PATCH', body: JSON.stringify({ sortIndex: j }) })
    await api(`/store/me/products/${b.id}`, { method: 'PATCH', body: JSON.stringify({ sortIndex: i }) })
  })
}
</script>

<template>
  <main class="mx-auto max-w-2xl space-y-4 p-4">
    <div class="flex items-center justify-between">
      <h1 class="text-xl font-bold">Cardápio</h1>
      <RouterLink to="/loja/cardapio/produto" class="rounded bg-black px-3 py-1 text-white">Novo produto</RouterLink>
    </div>
    <p v-if="error" class="text-sm text-red-600">{{ error }}</p>

    <form class="flex gap-2" @submit.prevent="addCategory">
      <input v-model="newCategory" required placeholder="Nova categoria" class="flex-1 rounded border p-2" />
      <button class="rounded border px-3">Criar</button>
    </form>

    <section v-for="(c, i) in catalog" :key="c.id" class="rounded border">
      <header class="flex items-center justify-between border-b bg-gray-50 p-2">
        <span class="font-semibold">{{ c.name }}</span>
        <span class="flex gap-2 text-sm">
          <button :disabled="i === 0" @click="swapCategory(i, i - 1)">↑</button>
          <button :disabled="i === catalog.length - 1" @click="swapCategory(i, i + 1)">↓</button>
          <button @click="renameCategory(c)">renomear</button>
          <button class="text-red-600" @click="removeCategory(c)">excluir</button>
        </span>
      </header>
      <ul class="divide-y">
        <li v-for="p in c.products" :key="p.id" class="flex items-center justify-between p-2" :class="!p.isAvailable && 'opacity-50'">
          <RouterLink :to="`/loja/cardapio/produto/${p.id}`" class="flex-1">
            {{ p.name }} <span class="text-sm text-gray-500">{{ formatBRL(p.basePriceCents) }}</span>
          </RouterLink>
          <span class="flex gap-2 text-sm">
            <button :disabled="c.products.indexOf(p) === 0" @click="swapProduct(c, c.products.indexOf(p), c.products.indexOf(p) - 1)">↑</button>
            <button :disabled="c.products.indexOf(p) === c.products.length - 1" @click="swapProduct(c, c.products.indexOf(p), c.products.indexOf(p) + 1)">↓</button>
            <button @click="toggleProduct(p)">{{ p.isAvailable ? 'pausar' : 'ativar' }}</button>
            <button class="text-red-600" @click="removeProduct(p)">excluir</button>
          </span>
        </li>
        <li v-if="c.products.length === 0" class="p-2 text-sm text-gray-400">Sem produtos</li>
      </ul>
    </section>
  </main>
</template>
