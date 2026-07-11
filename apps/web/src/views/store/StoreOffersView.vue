<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { formatBRL, parseBRLToCents } from '@delivery/shared/constants'
import type { OfferRecurrence } from '@delivery/shared'
import { api } from '../../lib/api'

type Offer = { id: string; status: 'OPEN' | 'CLOSED'; dailyRateCents: number; perDeliveryCents: number
  slots: number; acceptedCount: number; recurrence: OfferRecurrence; startTime: string; endTime: string; note: string | null
  acceptances: { driverUserId: string; driverName: string; driverPhone: string | null }[] }
const DOW = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb']
const offers = ref<Offer[]>([])
const error = ref('')
const success = ref('')
const saving = ref(false)
const form = reactive({ daily: '', extra: '', slots: 1, kind: 'WEEKLY' as 'WEEKLY' | 'DATES', days: [1] as number[],
  dates: [''] as string[], start: '09:00', end: '18:00', note: '' })
function toggle(day: number) {
  const index = form.days.indexOf(day)
  if (index >= 0) form.days.splice(index, 1)
  else form.days.push(day)
}
function recurrenceLabel(recurrence: OfferRecurrence) {
  return recurrence.kind === 'WEEKLY' ? recurrence.days.map((day) => DOW[day]).join(', ')
    : recurrence.dates.map((date) => date.split('-').reverse().slice(0, 2).join('/')).join(', ')
}
async function load() {
  try { offers.value = await api<Offer[]>('/store/me/offers') }
  catch (e) { error.value = e instanceof Error ? e.message : 'Erro ao carregar' }
}
async function publish() {
  const dailyRateCents = parseBRLToCents(form.daily); const perDeliveryCents = parseBRLToCents(form.extra)
  const dates = form.dates.filter(Boolean)
  if (dailyRateCents == null || perDeliveryCents == null) { error.value = 'Informe valores válidos'; return }
  if (form.kind === 'WEEKLY' ? !form.days.length : !dates.length) { error.value = 'Escolha ao menos um dia ou data'; return }
  saving.value = true; error.value = ''; success.value = ''
  try {
    await api('/store/me/offers', { method: 'POST', body: JSON.stringify({ dailyRateCents, perDeliveryCents, slots: form.slots,
      recurrence: form.kind === 'WEEKLY' ? { kind: 'WEEKLY', days: [...form.days].sort() } : { kind: 'DATES', dates: [...dates].sort() },
      start: form.start, end: form.end, note: form.note || null,
    }) })
    form.daily = ''; form.extra = ''; form.note = ''; success.value = 'Vaga publicada.'; await load()
  } catch (e) { error.value = e instanceof Error ? e.message : 'Erro ao publicar' }
  finally { saving.value = false }
}
async function close(id: string) {
  if (!confirm('Encerrar esta oferta? Ela deixará de aparecer para entregadores.')) return
  try { await api(`/store/me/offers/${id}/close`, { method: 'POST' }); await load() }
  catch (e) { error.value = e instanceof Error ? e.message : 'Erro ao encerrar' }
}
onMounted(load)
</script>

<template>
  <main class="mx-auto max-w-3xl p-4">
    <h1 class="text-xl font-bold">Vagas de trabalho</h1>
    <p class="text-sm text-gray-500">Ao aceitar, o entregador entra como vínculo confirmado com estes termos.</p>
    <p v-if="error" class="mt-2 text-sm text-red-600">{{ error }}</p><p v-if="success" class="mt-2 text-sm text-green-700">{{ success }}</p>
    <form class="mt-4 grid gap-2 rounded border p-3 sm:grid-cols-3" @submit.prevent="publish">
      <input v-model="form.daily" required inputmode="decimal" placeholder="Diária (R$)" class="rounded border p-2">
      <input v-model="form.extra" required inputmode="decimal" placeholder="Extra/entrega (R$)" class="rounded border p-2">
      <input v-model.number="form.slots" required type="number" min="1" max="20" placeholder="Vagas" class="rounded border p-2">
      <div class="flex gap-4 sm:col-span-3"><label><input v-model="form.kind" type="radio" value="WEEKLY"> Dias da semana</label><label><input v-model="form.kind" type="radio" value="DATES"> Datas específicas</label></div>
      <div v-if="form.kind === 'WEEKLY'" class="flex flex-wrap gap-1 sm:col-span-3">
        <label v-for="(label, day) in DOW" :key="label" class="cursor-pointer rounded border px-2 py-1 text-sm" :class="form.days.includes(day) && 'bg-black text-white'">
          <input type="checkbox" class="hidden" :checked="form.days.includes(day)" @change="toggle(day)">{{ label }}
        </label>
      </div>
      <div v-else class="space-y-2 sm:col-span-3">
        <div v-for="(_, index) in form.dates" :key="index" class="flex gap-2"><input v-model="form.dates[index]" type="date" class="rounded border p-2"><button v-if="form.dates.length > 1" type="button" class="rounded border px-2" @click="form.dates.splice(index, 1)">Remover</button></div>
        <button type="button" class="text-sm underline" :disabled="form.dates.length >= 30" @click="form.dates.push('')">+ Adicionar data</button>
      </div>
      <input v-model="form.start" required type="time" class="rounded border p-2"><input v-model="form.end" required type="time" class="rounded border p-2">
      <input v-model="form.note" maxlength="500" placeholder="Observação (opcional)" class="rounded border p-2">
      <button :disabled="saving" class="rounded bg-black p-2 font-semibold text-white sm:col-span-3">Publicar vaga</button>
    </form>
    <h2 class="mt-6 font-semibold">Ofertas publicadas</h2><p v-if="!offers.length" class="mt-2 text-sm text-gray-500">Nenhuma oferta publicada.</p>
    <ul class="mt-2 space-y-3"><li v-for="offer in offers" :key="offer.id" class="rounded border p-3 text-sm">
      <div class="flex justify-between gap-3"><div><strong>{{ offer.status === 'OPEN' ? 'Aberta' : 'Encerrada' }}</strong> · {{ offer.acceptedCount }}/{{ offer.slots }} aceitas<br>{{ formatBRL(offer.dailyRateCents) }}/dia + {{ formatBRL(offer.perDeliveryCents) }}/entrega<br><span class="text-gray-500">{{ recurrenceLabel(offer.recurrence) }} · {{ offer.startTime }}–{{ offer.endTime }}</span><p v-if="offer.note" class="mt-1">{{ offer.note }}</p></div><button v-if="offer.status === 'OPEN'" class="h-fit rounded border px-2 py-1" @click="close(offer.id)">Encerrar</button></div>
      <div v-if="offer.acceptances.length" class="mt-3 border-t pt-2"><strong>Aceites</strong><ul><li v-for="person in offer.acceptances" :key="person.driverUserId">{{ person.driverName }}<span v-if="person.driverPhone"> · {{ person.driverPhone }}</span></li></ul></div>
    </li></ul>
  </main>
</template>
