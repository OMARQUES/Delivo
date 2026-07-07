<script setup lang="ts">
import { useRoute } from 'vue-router'

const route = useRoute()
const storeSlug = route.params.storeSlug as string
</script>

<template>
  <main class="mx-auto max-w-lg p-4">
    <h1 class="text-2xl font-bold">{{ storeSlug }}</h1>
    <p class="mt-2 text-gray-600">Catálogo da loja entra no plano de catálogo.</p>
  </main>
</template>
