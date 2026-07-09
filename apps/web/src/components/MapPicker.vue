<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import markerIcon2x from 'leaflet/dist/images/marker-icon-2x.png'
import markerIcon from 'leaflet/dist/images/marker-icon.png'
import markerShadow from 'leaflet/dist/images/marker-shadow.png'

// Fix: bundlers quebram as URLs default dos ícones do Leaflet (404 no marker).
delete (L.Icon.Default.prototype as unknown as { _getIconUrl?: unknown })._getIconUrl
L.Icon.Default.mergeOptions({
  iconRetinaUrl: markerIcon2x,
  iconUrl: markerIcon,
  shadowUrl: markerShadow,
})

const props = defineProps<{ lat: number; lng: number }>()
const emit = defineEmits<{ (e: 'update', v: { lat: number; lng: number }): void }>()

const el = ref<HTMLDivElement>()
let map: L.Map | undefined
let marker: L.Marker | undefined

onMounted(() => {
  map = L.map(el.value!).setView([props.lat, props.lng], 15)
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap',
  }).addTo(map)
  marker = L.marker([props.lat, props.lng], { draggable: true }).addTo(map)
  marker.on('dragend', () => {
    const p = marker!.getLatLng()
    emit('update', { lat: p.lat, lng: p.lng })
  })
  map.on('click', (ev: L.LeafletMouseEvent) => {
    marker!.setLatLng(ev.latlng)
    emit('update', { lat: ev.latlng.lat, lng: ev.latlng.lng })
  })
})

watch(
  () => [props.lat, props.lng] as const,
  ([lat, lng]) => marker?.setLatLng([lat, lng]),
)

onBeforeUnmount(() => map?.remove())
</script>

<template>
  <div ref="el" class="h-64 w-full rounded border"></div>
</template>
