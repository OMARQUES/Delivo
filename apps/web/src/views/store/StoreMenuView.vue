<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { api } from '../../lib/api'

type Option = { id: string; name: string; priceCents: number | null; isAvailable: boolean }
type Group = { id: string; name: string; type: string; options: Option[] }
type Product = {
  id: string
  name: string
  basePriceCents: number
  isAvailable: boolean
  sortIndex: number
  groups?: Group[]
}
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
const saveProductPrice = (p: Product, reaisStr: string) => {
  const reais = Number(reaisStr.replace(',', '.'))
  if (reaisStr.trim() === '' || !Number.isFinite(reais) || reais < 0) {
    error.value = 'Preço inválido'
    return
  }
  return run(() => api(`/store/me/products/${p.id}`, {
    method: 'PATCH', body: JSON.stringify({ basePriceCents: Math.round(reais * 100) }),
  }))
}
const toggleOption = (option: Option) =>
  run(() => api(`/store/me/options/${option.id}`, {
    method: 'PATCH', body: JSON.stringify({ isAvailable: !option.isAvailable }),
  }))
const saveOptionPrice = (option: Option, reaisStr: string) => {
  const reais = Number(reaisStr.replace(',', '.'))
  if (reaisStr.trim() === '' || !Number.isFinite(reais) || reais < 0) {
    error.value = 'Preço inválido'
    return
  }
  return run(() => api(`/store/me/options/${option.id}`, {
    method: 'PATCH', body: JSON.stringify({ priceCents: Math.round(reais * 100) }),
  }))
}
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
        <li v-for="p in c.products" :key="p.id" class="flex flex-wrap items-center justify-between p-2" :class="!p.isAvailable && 'opacity-50'">
          <div class="flex flex-1 items-center gap-2">
            <RouterLink :to="`/loja/cardapio/produto/${p.id}`" class="flex-1">{{ p.name }}</RouterLink>
            <span class="text-xs text-gray-500">R$</span>
            <input
              type="number"
              min="0"
              step="0.01"
              :value="(p.basePriceCents / 100).toFixed(2)"
              class="w-20 rounded border p-1 text-sm"
              aria-label="Preço do produto em reais"
              @change="saveProductPrice(p, ($event.target as HTMLInputElement).value)"
            />
          </div>
          <span class="flex gap-2 text-sm">
            <button :disabled="c.products.indexOf(p) === 0" @click="swapProduct(c, c.products.indexOf(p), c.products.indexOf(p) - 1)">↑</button>
            <button :disabled="c.products.indexOf(p) === c.products.length - 1" @click="swapProduct(c, c.products.indexOf(p), c.products.indexOf(p) + 1)">↓</button>
            <button @click="toggleProduct(p)">{{ p.isAvailable ? 'pausar' : 'ativar' }}</button>
            <button class="text-red-600" @click="removeProduct(p)">excluir</button>
          </span>
          <details v-if="p.groups && p.groups.length" class="mt-1 w-full">
            <summary class="cursor-pointer text-xs text-gray-500">
              Opções ({{ p.groups.reduce((total, group) => total + group.options.length, 0) }})
            </summary>
            <div v-for="group in p.groups" :key="group.id" class="mt-1 pl-2">
              <p class="text-xs font-semibold text-gray-600">{{ group.name }}</p>
              <ul class="divide-y">
                <li
                  v-for="option in group.options"
                  :key="option.id"
                  class="flex items-center gap-2 py-1 text-sm"
                  :class="!option.isAvailable && 'opacity-50'"
                >
                  <span class="flex-1">{{ option.name }}</span>
                  <template v-if="option.priceCents !== null">
                    <span class="text-xs text-gray-500">R$</span>
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      :value="(option.priceCents / 100).toFixed(2)"
                      class="w-20 rounded border p-1 text-xs"
                      aria-label="Preço da opção em reais"
                      @change="saveOptionPrice(option, ($event.target as HTMLInputElement).value)"
                    />
                  </template>
                  <button class="rounded border px-2 py-0.5 text-xs" @click="toggleOption(option)">
                    {{ option.isAvailable ? 'pausar' : 'ativar' }}
                  </button>
                </li>
              </ul>
            </div>
          </details>
        </li>
        <li v-if="c.products.length === 0" class="p-2 text-sm text-gray-400">Sem produtos</li>
      </ul>
    </section>
  </main>
</template>
