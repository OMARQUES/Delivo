<template>
  <div class="min-h-screen">
    <header class="flex items-center gap-4 border-b p-4">
      <span class="font-semibold">Admin da Plataforma</span>
      <nav class="flex gap-3 text-sm">
        <RouterLink to="/admin/lojas" class="underline">Lojas</RouterLink>
        <RouterLink to="/admin/entregadores" class="underline">Entregadores</RouterLink>
        <RouterLink to="/admin/financeiro" class="underline">Financeiro</RouterLink>
      </nav>
    </header>
    <RouterView />
  </div>
</template>
