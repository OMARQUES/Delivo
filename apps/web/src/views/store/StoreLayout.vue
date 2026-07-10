<template>
  <div class="min-h-screen">
    <header class="flex items-center gap-4 border-b p-4">
      <span class="font-semibold">Painel da Loja</span>
      <nav class="flex gap-3 text-sm">
        <RouterLink to="/loja/pedidos" class="underline">Pedidos</RouterLink>
        <RouterLink to="/loja/perfil" class="underline">Perfil</RouterLink>
        <RouterLink to="/loja/cardapio" class="underline">Cardápio</RouterLink>
        <RouterLink to="/loja/financeiro" class="underline">Financeiro</RouterLink>
        <RouterLink to="/loja/entregadores" class="underline">Entregadores</RouterLink>
      </nav>
    </header>
    <RouterView />
  </div>
</template>
