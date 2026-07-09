<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { api } from '../lib/api'
import ProductModal from '../components/ProductModal.vue'
import { formatBRL, minMenuPrice, type MenuProduct, type Selection } from '@delivery/shared/constants'
import { useCartStore } from '../stores/cart'

type PublicStore = {
  name: string; slug: string; category: string; phone: string; addressText: string
  logoKey: string | null; isOpen: boolean
  deliveryEtaMinutes: [number, number] | null; pickupEtaMinutes: [number, number] | null
  minOrderCents: number | null
}

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:8787'
const route = useRoute()
const cart = useCartStore()
const store = ref<PublicStore | null>(null)
const notFound = ref(false)

type MenuCategory = { id: string; name: string; products: (MenuProduct & { description: string | null; photoKey: string | null })[] }

const menu = ref<MenuCategory[]>([])
const filter = ref('')
const selected = ref<(MenuProduct & { photoKey: string | null }) | null>(null)

async function load(slug: string) {
  notFound.value = false
  store.value = null
  menu.value = []
  filter.value = ''
  selected.value = null
  try {
    store.value = await api<PublicStore>(`/stores/${slug}`)
    const m = await api<{ categories: MenuCategory[] }>(`/stores/${slug}/menu`)
    menu.value = m.categories
  } catch {
    notFound.value = true
  }
}

const filteredMenu = computed(() =>
  menu.value
    .map((c) => ({
      ...c,
      products: c.products.filter(
        (p) => !filter.value || p.name.toLowerCase().includes(filter.value.toLowerCase()),
      ),
    }))
    .filter((c) => c.products.length > 0),
)

function onAdd(payload: { selections: Selection[]; quantity: number }) {
  if (!selected.value || !store.value) return
  const r = cart.addItem(store.value.slug, store.value.name, selected.value, payload.selections, payload.quantity)
  if (r === 'other-store') {
    if (confirm(`Seu carrinho tem itens de ${cart.storeName}. Limpar e começar nesta loja?`)) {
      cart.clear()
      cart.addItem(store.value.slug, store.value.name, selected.value, payload.selections, payload.quantity)
    } else {
      return
    }
  }
  selected.value = null
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
      <input v-model="filter" placeholder="Buscar no cardápio…" class="mt-4 w-full rounded border p-2" />
      <section v-for="c in filteredMenu" :key="c.id" class="mt-4">
        <h2 class="font-semibold">{{ c.name }}</h2>
        <ul class="mt-1 space-y-1">
          <li
            v-for="p in c.products"
            :key="p.id"
            class="flex cursor-pointer items-center gap-3 rounded border p-2"
            :class="!p.isAvailable && 'opacity-50'"
            @click="selected = p"
          >
            <img v-if="p.photoKey" :src="`${API_URL}/media/${p.photoKey}`" class="h-12 w-12 rounded object-cover" alt="" />
            <div class="flex-1">
              <p>{{ p.name }}</p>
              <p v-if="p.description" class="text-xs text-gray-500">{{ p.description }}</p>
            </div>
            <span class="text-sm">{{ p.groups.length ? 'a partir de ' : '' }}{{ formatBRL(minMenuPrice(p)) }}</span>
          </li>
        </ul>
      </section>
      <p v-if="filteredMenu.length === 0" class="mt-6 text-gray-500">Nada no cardápio.</p>
      <ProductModal
        v-if="selected"
        :product="selected"
        :photo-url="selected.photoKey ? `${API_URL}/media/${selected.photoKey}` : null"
        @close="selected = null"
        @add="onAdd"
      />
      <RouterLink
        v-if="!cart.isEmpty && cart.storeSlug === store?.slug"
        to="/checkout"
        class="fixed bottom-3 left-1/2 w-[92%] max-w-md -translate-x-1/2 rounded bg-black p-3 text-center font-semibold text-white"
      >
        Ver carrinho ({{ cart.count }}) — {{ formatBRL(cart.subtotalCents) }}
      </RouterLink>
    </template>
    <p v-else class="text-gray-500">Carregando…</p>
  </main>
</template>
