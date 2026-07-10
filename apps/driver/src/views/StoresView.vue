<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { formatBRL } from '@delivery/shared/constants'
import { api } from '../lib/api'

type Link = {
  id: string
  status: 'INVITED' | 'CONFIRMED'
  storeName: string
  storeAddressText: string
  dailyRateCents: number
  perDeliveryCents: number
}
const links = ref<Link[]>([])
const error = ref('')
async function load() {
  try { links.value = await api<Link[]>('/driver/links') }
  catch (e) { error.value = e instanceof Error ? e.message : 'Erro' }
}
async function confirm(id: string) {
  try { await api(`/driver/links/${id}/confirm`, { method: 'POST' }); await load() }
  catch (e) { error.value = e instanceof Error ? e.message : 'Erro' }
}
onMounted(load)
</script>

<template>
  <main class="mx-auto max-w-lg p-4">
    <h1 class="text-xl font-bold">Minhas lojas</h1>
    <p v-if="error" class="mt-2 text-sm text-red-600">{{ error }}</p>
    <p v-if="!links.length" class="mt-4 text-gray-500">Nenhum vínculo ou convite.</p>
    <ul class="mt-3 space-y-2">
      <li v-for="link in links" :key="link.id" class="rounded border p-3">
        <div class="flex justify-between gap-3">
          <div><p class="font-semibold">{{ link.storeName }}</p><p class="text-xs text-gray-500">{{ link.storeAddressText }}</p></div>
          <span class="text-xs" :class="link.status === 'CONFIRMED' ? 'text-green-700' : 'text-yellow-700'">
            {{ link.status === 'CONFIRMED' ? 'Confirmado' : 'Convite pendente' }}
          </span>
        </div>
        <p class="mt-2 text-sm">Diária {{ formatBRL(link.dailyRateCents) }} · extra {{ formatBRL(link.perDeliveryCents) }}/entrega</p>
        <button v-if="link.status === 'INVITED'" class="mt-2 w-full rounded bg-black p-2 text-white" @click="confirm(link.id)">Confirmar convite</button>
      </li>
    </ul>
  </main>
</template>
