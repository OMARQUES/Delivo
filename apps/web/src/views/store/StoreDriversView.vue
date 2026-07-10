<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { formatBRL, parseBRLToCents } from '@delivery/shared/constants'
import { api } from '../../lib/api'

type ScheduleItem = { dow: number; start: string; end: string }
type Link = {
  id: string; driverUserId: string; driverName: string; driverPhone: string | null
  status: 'INVITED' | 'CONFIRMED'; dailyRateCents: number; perDeliveryCents: number
  schedule: ScheduleItem[]
}
type Shift = { id: string; driverUserId: string; driverName: string; startedAt: string; earlyClose: boolean }

const DOW = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb']
const links = ref<Link[]>([])
const shifts = ref<Shift[]>([])
const error = ref('')
const saving = ref(false)

// convite (novo entregador) — agenda multi-dia: dias marcados usam o mesmo horário
const form = reactive({ phone: '', daily: '', extra: '', days: [1] as number[], start: '09:00', end: '18:00' })
// edição inline de um vínculo existente
const editing = ref<string | null>(null)
const editForm = reactive({ daily: '', extra: '', days: [] as number[], start: '09:00', end: '18:00' })

function toggle(list: number[], d: number) {
  const i = list.indexOf(d)
  if (i >= 0) list.splice(i, 1)
  else list.push(d)
}
function scheduleFrom(days: number[], start: string, end: string): ScheduleItem[] {
  return [...days].sort((a, b) => a - b).map((dow) => ({ dow, start, end }))
}
function daysLabel(schedule: ScheduleItem[]) {
  if (!schedule.length) return 'sem dias definidos'
  const first = schedule[0]!
  return `${schedule.map((s) => DOW[s.dow]).join(', ')} · ${first.start}–${first.end}`
}

async function load() {
  try {
    ;[links.value, shifts.value] = await Promise.all([
      api<Link[]>('/store/me/drivers'), api<Shift[]>('/store/me/shifts'),
    ])
  } catch (e) { error.value = e instanceof Error ? e.message : 'Erro' }
}

async function invite() {
  const dailyRateCents = parseBRLToCents(form.daily)
  const perDeliveryCents = parseBRLToCents(form.extra)
  if (dailyRateCents == null || perDeliveryCents == null) { error.value = 'Informe valores válidos'; return }
  if (!form.days.length) { error.value = 'Escolha ao menos um dia'; return }
  saving.value = true; error.value = ''
  try {
    await api('/store/me/drivers', { method: 'POST', body: JSON.stringify({
      phone: form.phone, dailyRateCents, perDeliveryCents,
      schedule: scheduleFrom(form.days, form.start, form.end),
    }) })
    form.phone = ''; form.daily = ''; form.extra = ''; form.days = [1]
    await load()
  } catch (e) { error.value = e instanceof Error ? e.message : 'Erro' }
  finally { saving.value = false }
}

function openEdit(link: Link) {
  editing.value = link.id
  editForm.daily = (link.dailyRateCents / 100).toFixed(2).replace('.', ',')
  editForm.extra = (link.perDeliveryCents / 100).toFixed(2).replace('.', ',')
  editForm.days = link.schedule.map((s) => s.dow)
  editForm.start = link.schedule[0]?.start ?? '09:00'
  editForm.end = link.schedule[0]?.end ?? '18:00'
}
async function saveEdit(link: Link) {
  const dailyRateCents = parseBRLToCents(editForm.daily)
  const perDeliveryCents = parseBRLToCents(editForm.extra)
  if (dailyRateCents == null || perDeliveryCents == null) { error.value = 'Valores inválidos'; return }
  error.value = ''
  try {
    await api(`/store/me/drivers/${link.id}`, { method: 'PATCH', body: JSON.stringify({
      dailyRateCents, perDeliveryCents, schedule: scheduleFrom(editForm.days, editForm.start, editForm.end),
    }) })
    editing.value = null
    await load()
  } catch (e) { error.value = e instanceof Error ? e.message : 'Erro' }
}

async function remove(id: string) { if (confirm('Remover este vínculo?')) { await api(`/store/me/drivers/${id}`, { method: 'DELETE' }); await load() } }
async function release(id: string) { if (confirm('Liberar o entregador e pagar a diária cheia?')) { await api(`/store/me/shifts/${id}/release`, { method: 'POST' }); await load() } }
onMounted(load)
</script>

<template>
  <main class="mx-auto max-w-3xl p-4">
    <h1 class="text-xl font-bold">Entregadores próprios</h1>
    <p class="text-sm text-gray-500">Um vínculo por entregador, com os dias que ele trabalha. Valores novos valem só para turnos futuros.</p>
    <p v-if="error" class="mt-2 text-sm text-red-600">{{ error }}</p>

    <form class="mt-4 grid gap-2 rounded border p-3 sm:grid-cols-3" @submit.prevent="invite">
      <input v-model="form.phone" required placeholder="Telefone" class="rounded border p-2" />
      <input v-model="form.daily" required inputmode="decimal" placeholder="Diária (R$)" class="rounded border p-2" />
      <input v-model="form.extra" required inputmode="decimal" placeholder="Extra/entrega (R$)" class="rounded border p-2" />
      <div class="flex flex-wrap items-center gap-1 sm:col-span-3">
        <label v-for="(d, i) in DOW" :key="d" class="cursor-pointer rounded border px-2 py-1 text-sm" :class="form.days.includes(i) && 'bg-black text-white'">
          <input type="checkbox" class="hidden" :checked="form.days.includes(i)" @change="toggle(form.days, i)" />{{ d }}
        </label>
        <input v-model="form.start" type="time" class="rounded border p-2" />
        <input v-model="form.end" type="time" class="rounded border p-2" />
      </div>
      <button :disabled="saving" class="rounded bg-black p-2 font-semibold text-white sm:col-span-3">Convidar</button>
    </form>

    <h2 class="mt-6 font-semibold">Vínculos</h2>
    <ul class="mt-2 space-y-2">
      <li v-for="link in links" :key="link.id" class="rounded border p-3 text-sm">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <span>
            <strong>{{ link.driverName }}</strong> · {{ link.driverPhone }}<br>
            {{ link.status === 'CONFIRMED' ? 'Confirmado' : 'Convite pendente' }} · {{ formatBRL(link.dailyRateCents) }}/dia + {{ formatBRL(link.perDeliveryCents) }}/entrega<br>
            <span class="text-gray-500">{{ daysLabel(link.schedule) }}</span>
          </span>
          <span class="flex gap-2">
            <button class="rounded border px-2 py-1" @click="editing === link.id ? (editing = null) : openEdit(link)">{{ editing === link.id ? 'Fechar' : 'Editar' }}</button>
            <button class="rounded border border-red-400 px-2 py-1 text-red-600" @click="remove(link.id)">Remover</button>
          </span>
        </div>
        <div v-if="editing === link.id" class="mt-3 grid gap-2 border-t pt-3 sm:grid-cols-2">
          <input v-model="editForm.daily" inputmode="decimal" placeholder="Diária (R$)" class="rounded border p-2" />
          <input v-model="editForm.extra" inputmode="decimal" placeholder="Extra/entrega (R$)" class="rounded border p-2" />
          <div class="flex flex-wrap items-center gap-1 sm:col-span-2">
            <label v-for="(d, i) in DOW" :key="d" class="cursor-pointer rounded border px-2 py-1" :class="editForm.days.includes(i) && 'bg-black text-white'">
              <input type="checkbox" class="hidden" :checked="editForm.days.includes(i)" @change="toggle(editForm.days, i)" />{{ d }}
            </label>
            <input v-model="editForm.start" type="time" class="rounded border p-2" />
            <input v-model="editForm.end" type="time" class="rounded border p-2" />
          </div>
          <button class="rounded bg-black p-2 font-semibold text-white sm:col-span-2" @click="saveEdit(link)">Salvar alterações</button>
        </div>
      </li>
    </ul>

    <h2 class="mt-6 font-semibold">Turnos ativos</h2>
    <p v-if="!shifts.length" class="mt-2 text-sm text-gray-500">Nenhum turno ativo.</p>
    <ul class="mt-2 space-y-2">
      <li v-for="shift in shifts" :key="shift.id" class="flex items-center justify-between rounded border p-3 text-sm">
        <span><strong>{{ shift.driverName }}</strong> · desde {{ new Date(shift.startedAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) }}</span>
        <button class="rounded border px-2 py-1" @click="release(shift.id)">Liberar</button>
      </li>
    </ul>
  </main>
</template>
