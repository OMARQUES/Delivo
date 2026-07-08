<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { STORE_CATEGORIES, slugify } from '@delivery/shared/constants'
import { api } from '../../lib/api'

type AdminStore = { id: string; name: string; slug: string; category: string; isActive: boolean }

const stores = ref<AdminStore[]>([])
const error = ref('')
const saving = ref(false)
const showForm = ref(false)

const form = reactive({
  name: '',
  slug: '',
  category: 'PIZZARIA',
  phone: '',
  city: '',
  addressText: '',
  lat: -23.5,
  lng: -51.9,
  owner: { name: '', email: '', password: '' },
})

async function load() {
  stores.value = await api<AdminStore[]>('/admin/stores')
}
onMounted(() => load().catch((e) => (error.value = e.message)))

function suggestSlug() {
  if (!form.slug) form.slug = slugify(form.name)
}

async function createStore() {
  error.value = ''
  saving.value = true
  try {
    await api('/admin/stores', { method: 'POST', body: JSON.stringify(form) })
    showForm.value = false
    Object.assign(form, {
      name: '',
      slug: '',
      phone: '',
      addressText: '',
      owner: { name: '', email: '', password: '' },
    })
    await load()
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Erro'
  } finally {
    saving.value = false
  }
}

async function toggleActive(s: AdminStore) {
  await api(`/admin/stores/${s.id}/active`, {
    method: 'PATCH',
    body: JSON.stringify({ isActive: !s.isActive }),
  })
  await load()
}
</script>

<template>
  <main class="mx-auto max-w-2xl p-4">
    <div class="flex items-center justify-between">
      <h1 class="text-xl font-bold">Lojas</h1>
      <button class="rounded bg-black px-3 py-1 text-white" @click="showForm = !showForm">
        {{ showForm ? 'Fechar' : 'Nova loja' }}
      </button>
    </div>
    <p v-if="error" class="mt-2 text-sm text-red-600">{{ error }}</p>

    <form v-if="showForm" class="mt-4 space-y-2 rounded border p-4" @submit.prevent="createStore">
      <input
        v-model="form.name"
        required
        placeholder="Nome da loja"
        class="w-full rounded border p-2"
        @blur="suggestSlug"
      />
      <input
        v-model="form.slug"
        required
        placeholder="slug-da-loja"
        class="w-full rounded border p-2"
      />
      <select v-model="form.category" class="w-full rounded border p-2">
        <option v-for="(label, key) in STORE_CATEGORIES" :key="key" :value="key">
          {{ label }}
        </option>
      </select>
      <input
        v-model="form.phone"
        required
        placeholder="WhatsApp da loja"
        class="w-full rounded border p-2"
      />
      <input v-model="form.city" required placeholder="Cidade" class="w-full rounded border p-2" />
      <input
        v-model="form.addressText"
        required
        placeholder="Endereço"
        class="w-full rounded border p-2"
      />
      <div class="grid grid-cols-2 gap-2">
        <input
          v-model.number="form.lat"
          type="number"
          step="any"
          required
          placeholder="Lat"
          class="rounded border p-2"
        />
        <input
          v-model.number="form.lng"
          type="number"
          step="any"
          required
          placeholder="Lng"
          class="rounded border p-2"
        />
      </div>
      <p class="pt-2 text-sm font-semibold">Dono (login da loja)</p>
      <input
        v-model="form.owner.name"
        required
        placeholder="Nome do dono"
        class="w-full rounded border p-2"
      />
      <input
        v-model="form.owner.email"
        type="email"
        required
        placeholder="Email de login"
        class="w-full rounded border p-2"
      />
      <input
        v-model="form.owner.password"
        required
        minlength="8"
        placeholder="Senha inicial"
        class="w-full rounded border p-2"
      />
      <button
        type="submit"
        :disabled="saving"
        class="w-full rounded bg-black p-2 text-white disabled:opacity-50"
      >
        {{ saving ? 'Criando…' : 'Criar loja' }}
      </button>
    </form>

    <ul class="mt-4 divide-y rounded border">
      <li v-for="s in stores" :key="s.id" class="flex items-center justify-between p-3">
        <div>
          <p class="font-medium">
            {{ s.name }} <span class="text-xs text-gray-500">/{{ s.slug }}</span>
          </p>
          <p class="text-xs text-gray-500">
            {{ s.category }} · {{ s.isActive ? 'ativa' : 'bloqueada' }}
          </p>
        </div>
        <button class="rounded border px-2 py-1 text-sm" @click="toggleActive(s)">
          {{ s.isActive ? 'Bloquear' : 'Desbloquear' }}
        </button>
      </li>
    </ul>
  </main>
</template>
