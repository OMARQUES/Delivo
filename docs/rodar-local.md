# Rodar local (dev)

Monorepo pnpm. Rodar da **raiz** do projeto. Cada serviço num terminal separado.

## Pré-requisito: Postgres (uma vez)

```bash
docker compose up -d postgres
```
> Terminal flatpak do VS Code não enxerga o docker do host — usar:
> ```bash
> flatpak-spawn --host docker compose up -d postgres
> ```

Migrations (quando o schema muda):
```bash
pnpm --filter @delivery/api db:migrate
```
> ⚠️ **Sempre rode isto depois de puxar um plano que adiciona migration** (ex.: uma
> feature nova do Codex). Os testes migram o `delivery_test` sozinhos, mas o banco de
> DEV (`delivery`) que a API usa NÃO — sem `db:migrate` as telas novas dão 500
> ("column/relation does not exist"). Conferir pendências:
> `docker compose exec -T postgres psql -U postgres -d delivery -c "select count(*) from drizzle.__drizzle_migrations"`
> comparado ao nº de arquivos em `apps/api/drizzle/*.sql`.

## Serviços (um terminal cada)

| Serviço | Comando | URL |
|---|---|---|
| **API** (Hono/Workers) | `pnpm dev:api` | http://localhost:8787 |
| **Web** (cliente + loja + admin) | `pnpm dev:web` | http://localhost:5173 |
| **Driver** (entregador) | `pnpm dev:driver` | http://localhost:5174 |

Equivalem a `pnpm --filter @delivery/<app> dev`.

## URLs úteis (web)

- Loja / cardápio: http://localhost:5173/loja/cardapio
- Loja / pedidos (pacotes): http://localhost:5173/loja/pedidos
- Loja / financeiro: http://localhost:5173/loja/financeiro
- Admin / lojas (comissão): http://localhost:5173/admin/lojas
- Admin / financeiro: http://localhost:5173/admin/financeiro
- Cardápio público: http://localhost:5173/`<slug-da-loja>`
- Driver: http://localhost:5174 · Ganhos: http://localhost:5174/financeiro

## PIX simulado (dev)

Sandbox do Mercado Pago não paga PIX de teste. Simular o efeito do webhook:
```bash
./scripts/pagar-pix-dev.sh              # paga o AWAITING_PAYMENT mais recente
./scripts/pagar-pix-dev.sh <order_id>   # ou por id / código copia-e-cola
```

## Parar

`Ctrl+C` em cada terminal. Postgres: `docker compose stop postgres`.

## Verificação (gate)

```bash
pnpm typecheck && pnpm test && pnpm lint && pnpm build
```

---

## Política de commits — sem coautor

Hook versionado em `.githooks/commit-msg` remove automaticamente qualquer trailer
`Co-Authored-By: ...claude/anthropic...`. Ativado via `core.hooksPath`.

Setup (automático no `pnpm install` via script `prepare`; manual se precisar):
```bash
git config core.hooksPath .githooks
```
