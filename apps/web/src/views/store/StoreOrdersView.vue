<script setup lang="ts">
import { ORDER_STATUS_LABELS, ORDER_STATUSES } from '@delivery/shared'
</script>

<template>
  <main class="p-4">
    <h1 class="text-xl font-bold">Pedidos</h1>
    <ul class="mt-2 space-y-1">
      <li v-for="s in ORDER_STATUSES" :key="s" class="text-sm text-gray-600">
        {{ ORDER_STATUS_LABELS[s] }}
      </li>
    </ul>
  </main>
</template>
