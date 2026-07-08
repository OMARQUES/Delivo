/** Categorias de loja (chave estável no banco, label PT-BR na UI) */
export const STORE_CATEGORIES = {
  PIZZARIA: 'Pizzaria',
  LANCHES: 'Lanches',
  RESTAURANTE: 'Restaurante',
  MERCADO: 'Mercado',
  FARMACIA: 'Farmácia',
  ACOUGUE: 'Açougue',
  BEBIDAS: 'Bebidas',
  DOCES: 'Doces & Sorvetes',
  CONVENIENCIA: 'Conveniência',
  OUTROS: 'Outros',
} as const
export type StoreCategory = keyof typeof STORE_CATEGORIES

/** Slugs que colidem com rotas do app — nunca podem ser slug de loja */
export const RESERVED_SLUGS = [
  'admin', 'loja', 'login', 'cadastro', 'auth', 'api', 'docs', 'health',
  'media', 'stores', 'store', 'entregador', 'sobre', 'privacidade', 'termos',
] as const

/** Nome → slug url-safe (remove acentos, minúsculas, hífens) */
export function slugify(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}
