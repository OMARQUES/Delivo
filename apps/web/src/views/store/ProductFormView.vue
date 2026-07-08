<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { api } from '../../lib/api'

type Opt = { name: string; priceCents: number | null; isAvailable: boolean; variationPrices?: Record<string, number> }
type Group = { name: string; type: 'VARIATION' | 'ADDON' | 'FLAVOR'; minSelect: number; maxSelect: number; options: Opt[] }
type CatalogCategory = { id: string; name: string; products: { id: string }[] }
type LoadedProduct = {
  id: string; categoryId: string; name: string; description: string | null
  basePriceCents: number; isAvailable: boolean; photoKey: string | null
  groups: { name: string; type: Group['type']; minSelect: number; maxSelect: number
    options: { id: string; name: string; priceCents: number | null; isAvailable: boolean; variationPrices?: Record<string, number> }[] }[]
}

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:8787'
const route = useRoute()
const router = useRouter()
const productId = ref<string | null>((route.params.productId as string) || null)

const categories = ref<{ id: string; name: string }[]>([])
const form = reactive({ categoryId: '', name: '', description: '', basePriceCents: 0, isAvailable: true })
const groups = ref<Group[]>([])
const photoKey = ref<string | null>(null)
const msg = ref('')
const saving = ref(false)

onMounted(async () => {
  const catalog = await api<CatalogCategory[]>('/store/me/catalog')
  categories.value = catalog.map((c) => ({ id: c.id, name: c.name }))
  if (productId.value) {
    const prod = (catalog as unknown as (CatalogCategory & { products: LoadedProduct[] })[])
      .flatMap((c) => c.products)
      .find((p) => p.id === productId.value)
    if (prod) {
      Object.assign(form, {
        categoryId: prod.categoryId, name: prod.name, description: prod.description ?? '',
        basePriceCents: prod.basePriceCents, isAvailable: prod.isAvailable,
      })
      photoKey.value = prod.photoKey
      // matriz volta com chave = id da opção de variação; converter pra índice
      const varOptions = prod.groups.find((g) => g.type === 'VARIATION')?.options ?? []
      const idToIndex = new Map(varOptions.map((o, i) => [o.id, String(i)]))
      groups.value = prod.groups.map((g) => ({
        name: g.name, type: g.type, minSelect: g.minSelect, maxSelect: g.maxSelect,
        options: g.options.map((o) => ({
          name: o.name, priceCents: o.priceCents, isAvailable: o.isAvailable,
          ...(o.variationPrices
            ? { variationPrices: Object.fromEntries(Object.entries(o.variationPrices).map(([id, v]) => [idToIndex.get(id) ?? id, v])) }
            : {}),
        })),
      }))
    }
  } else if (categories.value[0]) {
    form.categoryId = categories.value[0].id
  }
})

const variationGroup = computed(() => groups.value.find((g) => g.type === 'VARIATION'))
const hasVariation = computed(() => Boolean(variationGroup.value))
const hasFlavor = computed(() => groups.value.some((g) => g.type === 'FLAVOR'))

function addGroup(type: Group['type']) {
  groups.value.push({
    name: type === 'VARIATION' ? 'Tamanho' : type === 'FLAVOR' ? 'Sabores' : 'Adicionais',
    type, minSelect: type === 'ADDON' ? 0 : 1, maxSelect: type === 'FLAVOR' ? 2 : 1,
    options: [{ name: '', priceCents: null, isAvailable: true }],
  })
}
function remapMatrixAfterVariationRemoval(removedIndex: number) {
  for (const g of groups.value) {
    if (g.type !== 'FLAVOR') continue
    for (const o of g.options) {
      if (!o.variationPrices) continue
      const next: Record<string, number> = {}
      for (const [k, v] of Object.entries(o.variationPrices)) {
        const i = Number(k)
        if (i === removedIndex) continue // preço da variação removida morre
        next[String(i > removedIndex ? i - 1 : i)] = v
      }
      o.variationPrices = Object.keys(next).length ? next : undefined
    }
  }
}

function clearAllMatrices() {
  for (const g of groups.value) {
    if (g.type !== 'FLAVOR') continue
    for (const o of g.options) o.variationPrices = undefined
  }
}

function removeGroup(gi: number) {
  const wasVariation = groups.value[gi]?.type === 'VARIATION'
  groups.value.splice(gi, 1)
  if (wasVariation) clearAllMatrices()
}
const addOption = (g: Group) => g.options.push({ name: '', priceCents: null, isAvailable: true })
function removeOption(g: Group, oi: number) {
  g.options.splice(oi, 1)
  if (g.type === 'VARIATION') remapMatrixAfterVariationRemoval(oi)
}

function setPrice(o: Opt, ev: Event) {
  const v = (ev.target as HTMLInputElement).value
  o.priceCents = v === '' ? null : Math.round(Number(v) * 100)
}

function setMatrix(opt: Opt, varIndex: number, ev: Event) {
  const v = (ev.target as HTMLInputElement).value
  const rec = { ...(opt.variationPrices ?? {}) }
  if (v === '') delete rec[String(varIndex)]
  else rec[String(varIndex)] = Math.round(Number(v) * 100)
  opt.variationPrices = Object.keys(rec).length ? rec : undefined
}

async function save() {
  msg.value = ''
  saving.value = true
  try {
    let id = productId.value
    const payload = {
      categoryId: form.categoryId, name: form.name,
      description: form.description.trim(),
      basePriceCents: form.basePriceCents, isAvailable: form.isAvailable,
    }
    if (id) await api(`/store/me/products/${id}`, { method: 'PATCH', body: JSON.stringify(payload) })
    else id = ((await api<{ id: string }>('/store/me/products', { method: 'POST', body: JSON.stringify(payload) })) ).id
    await api(`/store/me/products/${id}/options`, { method: 'PUT', body: JSON.stringify(groups.value) })
    msg.value = 'Salvo!'
    if (!productId.value) await router.replace(`/loja/cardapio/produto/${id}`)
    productId.value = id
  } catch (e) {
    msg.value = e instanceof Error ? e.message : 'Erro ao salvar'
  } finally {
    saving.value = false
  }
}

async function uploadPhoto(ev: Event) {
  const file = (ev.target as HTMLInputElement).files?.[0]
  if (!file || !productId.value) return
  try {
    const r = await api<{ photoKey: string }>(`/store/me/products/${productId.value}/photo`, {
      method: 'PUT', headers: { 'Content-Type': file.type }, body: file,
    })
    photoKey.value = r.photoKey
    msg.value = 'Foto atualizada!'
  } catch (e) {
    msg.value = e instanceof Error ? e.message : 'Erro no upload'
  }
}
</script>

<template>
  <main class="mx-auto max-w-2xl space-y-4 p-4">
    <h1 class="text-xl font-bold">{{ productId ? 'Editar produto' : 'Novo produto' }}</h1>

    <section class="space-y-2">
      <select v-model="form.categoryId" required class="w-full rounded border p-2">
        <option v-for="c in categories" :key="c.id" :value="c.id">{{ c.name }}</option>
      </select>
      <input v-model="form.name" required placeholder="Nome" class="w-full rounded border p-2" />
      <textarea v-model="form.description" placeholder="Descrição" class="w-full rounded border p-2"></textarea>
      <label class="block text-sm">Preço base (centavos)
        <input v-model.number="form.basePriceCents" type="number" min="0" class="w-full rounded border p-2" />
      </label>
      <label class="flex items-center gap-2 text-sm">
        <input v-model="form.isAvailable" type="checkbox" /> Disponível
      </label>
      <div v-if="productId" class="space-y-1">
        <img v-if="photoKey" :src="`${API_URL}/media/${photoKey}`" class="h-24 w-24 rounded object-cover" alt="" />
        <input type="file" accept="image/png,image/jpeg,image/webp" @change="uploadPhoto" />
      </div>
      <p v-else class="text-xs text-gray-500">Salve o produto pra enviar foto.</p>
    </section>

    <section class="space-y-3">
      <div class="flex gap-2">
        <button v-if="!hasVariation" class="rounded border px-2 py-1 text-sm" @click="addGroup('VARIATION')">+ Variações</button>
        <button v-if="!hasFlavor" class="rounded border px-2 py-1 text-sm" @click="addGroup('FLAVOR')">+ Sabores (meio-a-meio)</button>
        <button class="rounded border px-2 py-1 text-sm" @click="addGroup('ADDON')">+ Adicionais</button>
      </div>

      <div v-for="(g, gi) in groups" :key="gi" class="space-y-2 rounded border p-3">
        <div class="flex items-center gap-2">
          <span class="rounded bg-gray-200 px-2 text-xs">{{ g.type }}</span>
          <input v-model="g.name" class="flex-1 rounded border p-1" />
          <button class="text-sm text-red-600" @click="removeGroup(gi)">remover grupo</button>
        </div>
        <div v-if="g.type !== 'VARIATION'" class="flex gap-2 text-sm">
          <label>mín <input v-model.number="g.minSelect" type="number" min="0" class="w-16 rounded border p-1" /></label>
          <label>máx <input v-model.number="g.maxSelect" type="number" min="1" class="w-16 rounded border p-1" /></label>
        </div>

        <div v-for="(o, oi) in g.options" :key="oi" class="space-y-1 rounded border p-2">
          <div class="flex items-center gap-2">
            <input v-model="o.name" placeholder="Nome da opção" class="flex-1 rounded border p-1" />
            <input
              :value="o.priceCents == null ? '' : o.priceCents / 100"
              type="number" step="0.01" min="0"
              :placeholder="g.type === 'ADDON' ? '+R$' : 'R$'"
              class="w-24 rounded border p-1"
              @input="setPrice(o, $event)"
            />
            <label class="text-xs"><input v-model="o.isAvailable" type="checkbox" /> disp.</label>
            <button class="text-sm text-red-600" @click="removeOption(g, oi)">×</button>
          </div>
          <div v-if="g.type === 'FLAVOR' && hasVariation" class="flex flex-wrap gap-2 pl-2 text-xs">
            <label v-for="(vo, vi) in variationGroup!.options" :key="vi" class="flex items-center gap-1">
              {{ vo.name || `variação ${vi + 1}` }}:
              <input
                :value="o.variationPrices?.[String(vi)] != null ? o.variationPrices![String(vi)]! / 100 : ''"
                type="number" step="0.01" min="0" placeholder="R$"
                class="w-20 rounded border p-1"
                @input="setMatrix(o, vi, $event)"
              />
            </label>
          </div>
        </div>
        <button class="rounded border px-2 py-1 text-xs" @click="addOption(g)">+ opção</button>
      </div>
    </section>

    <p v-if="msg" class="text-sm" :class="['Salvo!', 'Foto atualizada!'].includes(msg) ? 'text-green-700' : 'text-red-600'">{{ msg }}</p>
    <div class="flex gap-2">
      <button :disabled="saving" class="flex-1 rounded bg-black p-2 text-white disabled:opacity-50" @click="save">
        {{ saving ? 'Salvando…' : 'Salvar' }}
      </button>
      <RouterLink to="/loja/cardapio" class="rounded border px-4 py-2">Voltar</RouterLink>
    </div>
  </main>
</template>
