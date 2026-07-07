import { createRouter, createWebHistory } from 'vue-router'

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'home', component: () => import('../views/HomeView.vue') },
    {
      path: '/loja',
      component: () => import('../views/store/StoreLayout.vue'),
      children: [
        { path: '', redirect: '/loja/pedidos' },
        {
          path: 'pedidos',
          name: 'store-orders',
          component: () => import('../views/store/StoreOrdersView.vue'),
        },
      ],
    },
    {
      path: '/admin',
      name: 'admin',
      component: () => import('../views/admin/AdminLayout.vue'),
    },
    // deep-link da loja: exemplo.com.br/NomeDaLoja — SEMPRE por último
    {
      path: '/:storeSlug',
      name: 'store-catalog',
      component: () => import('../views/StoreCatalogView.vue'),
    },
  ],
})
