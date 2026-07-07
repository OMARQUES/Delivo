# Delivo

Plataforma de delivery para cidades pequenas. 100% Cloudflare.

## Stack

- **API**: Hono + Drizzle no Cloudflare Workers, Postgres (Neon) via Hyperdrive
- **Web** (cliente/loja/admin): Vue 3 SPA em Workers Assets — deep-link `/:storeSlug`
- **Entregador**: Vue 3 SPA (futuro Capacitor Android + FCM)
- **Shared**: máquina de estados do pedido, schemas Zod (subpaths `/constants` e `/schemas`)

## Dev

```bash
corepack enable && pnpm install
cp apps/api/.dev.vars.example apps/api/.dev.vars  # contém JWT_SECRET local
docker compose up -d postgres
pnpm --filter @delivery/api db:migrate
pnpm --filter @delivery/api db:seed  # cria admin — precisa ADMIN_EMAIL/ADMIN_PASSWORD no apps/api/.env
pnpm dev:api     # http://localhost:8787 (docs em /docs)
pnpm dev:web     # http://localhost:5173
pnpm dev:driver  # http://localhost:5174
```

Auth já funciona: registro/login por email ou telefone, guards por role em `/loja` e `/admin`.

## Verificação

```bash
pnpm typecheck && pnpm test && pnpm lint && pnpm build
```

## Deploy (pendente — runbook)

Deploy prod ainda não executado. Quando houver conta Neon + token Cloudflare, seguir Tasks 9-10 de `docs/superpowers/plans/2026-07-06-fundacao-projeto.md` (Hyperdrive id real, secrets no GitHub, deploy.yml).

## Auth

Email+senha (PBKDF2) ou telefone; JWT de acesso (15min) + refresh token rotativo (30d). Google OAuth pendente — ver `docs/carry-forwards.md`.

## Specs e planos

- Requisitos funcionais: `docs/superpowers/specs/2026-07-06-requisitos-funcionais-design.md`
- Plano de fundação: `docs/superpowers/plans/2026-07-06-fundacao-projeto.md`
- Pendências técnicas: `docs/carry-forwards.md`

## Roadmap de planos

1. ✅ Fundação (este repo)
2. Auth — email+senha e Google, JWT + refresh, RBAC
3. Catálogo — lojas, categorias, produtos, variações, adicionais, meio-a-meio, busca, upload R2, Leaflet
4. Pedidos — carrinho, checkout (idempotente), máquina de status, amendment, retirada, painel loja, polling
5. Dispatch — broadcast FCM, aceite com lock atômico, batching multi-loja/multi-destino, telas driver
6. Pagamentos — Asaas PIX/cartão + split, estornos, webhooks
7. Financeiro — ledger, fatura de comissão, payout semanal
8. Capacitor — build Android driver, FCM nativo
9. Admin & Relatórios — gestão, import CSV, faturamento, mini-ERP
