<script setup lang="ts">
import { computed, ref } from 'vue'
import { calcItemPrice, formatBRL, type MenuProduct, type Selection } from '@delivery/shared/constants'

const props = defineProps<{ product: MenuProduct; photoUrl: string | null }>()
const emit = defineEmits<{ (e: 'close'): void }>()

const picked = ref<Record<string, string[]>>({})

function toggle(groupId: string, optionId: string, max: number, single: boolean) {
  const cur = picked.value[groupId] ?? []
  if (single) {
    picked.value = { ...picked.value, [groupId]: [optionId] }
    return
  }
  const has = cur.includes(optionId)
  if (has) picked.value = { ...picked.value, [groupId]: cur.filter((i) => i !== optionId) }
  else if (cur.length < max) picked.value = { ...picked.value, [groupId]: [...cur, optionId] }
}

const selections = computed<Selection[]>(() =>
  Object.entries(picked.value)
    .filter(([, ids]) => ids.length > 0)
    .map(([groupId, optionIds]) => ({ groupId, optionIds })),
)

const price = computed(() => calcItemPrice(props.product, selections.value))
</script>

<template>
  <div class="fixed inset-0 z-10 flex items-end justify-center bg-black/40 sm:items-center" @click.self="emit('close')">
    <div class="max-h-[85vh] w-full max-w-md overflow-y-auto rounded-t-lg bg-white p-4 sm:rounded-lg">
      <div class="flex items-start justify-between">
        <h2 class="text-lg font-bold">{{ product.name }}</h2>
        <button class="text-2xl leading-none" @click="emit('close')">×</button>
      </div>
      <img v-if="photoUrl" :src="photoUrl" class="mt-2 h-40 w-full rounded object-cover" alt="" />

      <section v-for="g in product.groups" :key="g.id" class="mt-4">
        <p class="font-semibold">
          {{ g.name }}
          <span class="text-xs font-normal text-gray-500">
            {{ g.type === 'VARIATION' ? 'escolha 1' : `escolha ${g.minSelect}-${g.maxSelect}` }}
          </span>
        </p>
        <label
          v-for="o in g.options"
          :key="o.id"
          class="mt-1 flex items-center gap-2 rounded border p-2"
          :class="!o.isAvailable && 'opacity-40'"
        >
          <input
            :type="g.type === 'VARIATION' ? 'radio' : 'checkbox'"
            :name="g.id"
            :disabled="!o.isAvailable"
            :checked="(picked[g.id] ?? []).includes(o.id)"
            @change="toggle(g.id, o.id, g.maxSelect, g.type === 'VARIATION')"
          />
          <span class="flex-1">{{ o.name }}</span>
          <span v-if="o.priceCents != null" class="text-sm text-gray-600">
            {{ g.type === 'ADDON' ? '+' : '' }}{{ formatBRL(o.priceCents) }}
          </span>
        </label>
      </section>

      <div class="mt-4 border-t pt-3">
        <p v-if="price.ok" class="text-lg font-bold">{{ formatBRL(price.totalCents) }}</p>
        <p v-else class="text-sm text-gray-500">{{ price.error }}</p>
        <button disabled class="mt-2 w-full rounded bg-gray-300 p-2 text-gray-600" title="Carrinho no próximo plano">
          Adicionar ao carrinho (em breve)
        </button>
      </div>
    </div>
  </div>
</template>
