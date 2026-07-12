<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { api } from '../../lib/api'

type Driver = {
  id: string
  name: string
  phone: string | null
  status: 'ACTIVE' | 'PENDING_APPROVAL' | 'BLOCKED'
  isAvailable: boolean
}

const drivers = ref<Driver[]>([])
const error = ref('')

async function load() {
  drivers.value = await api<Driver[]>('/admin/drivers')
}
onMounted(() => load().catch((e) => (error.value = e instanceof Error ? e.message : 'Erro')))

async function setStatus(d: Driver, status: 'ACTIVE' | 'BLOCKED') {
  error.value = ''
  try {
    await api(`/admin/drivers/${d.id}/status`, { method: 'PATCH', body: JSON.stringify({ status }) })
    await load()
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Erro'
  }
}
</script>

<template>
  <main class="mx-auto max-w-2xl p-4">
    <h1 class="text-xl font-bold">Entregadores</h1>
    <p v-if="error" class="mt-2 text-sm text-red-600">{{ error }}</p>
    <ul class="mt-4 divide-y rounded border">
      <li v-for="d in drivers" :key="d.id" class="flex items-center justify-between p-3">
        <div>
          <p class="font-medium">
            {{ d.name }}
            <span v-if="d.status === 'PENDING_APPROVAL'" class="ml-1 rounded bg-yellow-100 px-1 text-xs">aguardando aprovação</span>
            <span v-else-if="d.status === 'BLOCKED'" class="ml-1 rounded bg-red-100 px-1 text-xs">bloqueado</span>
            <span v-else-if="d.isAvailable" class="ml-1 rounded bg-green-100 px-1 text-xs">disponível</span>
          </p>
          <p class="text-xs text-gray-500">{{ d.phone }}</p>
        </div>
        <span class="flex gap-2 text-sm">
          <button v-if="d.status !== 'ACTIVE'" class="rounded bg-black px-2 py-1 text-white" @click="setStatus(d, 'ACTIVE')">
            {{ d.status === 'PENDING_APPROVAL' ? 'Aprovar' : 'Desbloquear' }}
          </button>
          <button v-if="d.status === 'ACTIVE'" class="rounded border border-red-400 px-2 py-1 text-red-600" @click="setStatus(d, 'BLOCKED')">
            Bloquear
          </button>
        </span>
      </li>
      <li v-if="drivers.length === 0" class="p-3 text-sm text-gray-400">Nenhum entregador cadastrado.</li>
    </ul>
  </main>
</template>
