# Go-to-Production — sair do local e rodar em ambiente real

> **Para o executor (Codex):** este documento mistura **passos manuais de console** (marcados 🖐 — só o Otávio pode fazer, exigem contas/credenciais) e **tarefas de código/CLI** (marcadas 🤖 — executáveis no repo). Execute na ordem das fases; cada fase termina com um smoke test. Não invente valores de secret — quando faltar credencial, pare e liste o que falta.

**Meta:** API (Cloudflare Worker) + web loja/cliente + app driver servidos publicamente, banco Neon, pagamentos MP reais de teste, push FCM, mídia em R2 — suficientes para testes reais com usuários, ainda sem hardening completo de produção final.

**Estado atual (verificado no repo em 2026-07-11):**

- `apps/api/wrangler.jsonc`: Hyperdrive com **id placeholder** (`000...0`), R2 `delivo-media` **não criado**, `ALLOWED_ORIGINS` só localhost, cron `*/5` configurado.
- Secrets só em `.dev.vars` (JWT_SECRET, FIREBASE__, MP__) — **nenhum secret de produção registrado** (`wrangler secret`).
- `apps/web` e `apps/driver`: Workers Assets (SPA), deploy script pronto (`pnpm build && wrangler deploy`), mas **sem `.env.production`** (API URL cai no fallback `http://localhost:8787`).
- Firebase: projeto `delivery-573f0` existe (config pública já no SW do driver).
- Google OAuth: **não implementado** (estrutura multi-provider pronta; sem rota, sem client GCP).
- CI existe (`.github/workflows/ci.yml`); **deploy.yml não existe** (Task 10 da fundação, nunca executada).
- Referência: fundação Tasks 9–10 em `docs/superpowers/plans/2026-07-06-fundacao-projeto.md:1327`.

---

## Fase 0 — Pré-requisitos de conta (🖐 tudo)

Contas necessárias (criar/ter acesso):

1. **Cloudflare** (Workers pago opcional; free tier serve pra teste — cron e Hyperdrive funcionam no free, R2 exige cartão).
2. **Neon** (free tier ok) — região `sa-east-1` (São Paulo) se disponível.
3. **Firebase/Google Cloud** — projeto `delivery-573f0` já existe; precisa acesso ao console.
4. **Mercado Pago** — conta de produção com credenciais de TESTE (já tem) e, quando for cobrar de verdade, credenciais LIVE + processo de homologação.
5. **GitHub** — repo com Actions habilitado (para deploy contínuo).

---

## Fase 1 — Banco (Neon + Hyperdrive)

1. 🖐 **Neon:** criar projeto `delivery`, copiar connection string (`postgres://user:pass@host/db?sslmode=require`). Guardar como `DATABASE_URL_PROD`.
2. 🖐 **Hyperdrive:** `npx wrangler hyperdrive create delivery-db --connection-string="<DATABASE_URL_PROD>"` → anotar o `id` (32 hex).
3. 🤖 **wrangler.jsonc:** substituir o id placeholder do Hyperdrive pelo real (`apps/api/wrangler.jsonc`).
4. 🤖 **Migrations no Neon:** `cd apps/api && DATABASE_URL="<DATABASE_URL_PROD>" pnpm db:migrate` — aplica 0000→0020. Banco novo = backfill da 0020 roda vazio (ok).
5. 🤖 **Seed mínimo:** avaliar `db:seed` — se o seed é de dev (dados fake), **não** rodar em prod; criar apenas o usuário ADMIN inicial (ver Fase 7, item admin).

## Fase 2 — Secrets da API (Worker)

Para cada um: `cd apps/api && wrangler secret put <NOME>` (🖐 fornece o valor, 🤖 pode rodar o comando se o valor estiver disponível):

| Secret                     | Valor                                       | Nota                                                                  |
| -------------------------- | ------------------------------------------- | --------------------------------------------------------------------- |
| `JWT_SECRET`               | **novo**, forte (`openssl rand -base64 48`) | NUNCA reusar o de dev                                                 |
| `FIREBASE_PROJECT_ID`      | `delivery-573f0`                            | pode ser var em vez de secret                                         |
| `FIREBASE_SERVICE_ACCOUNT` | JSON da service account em linha única      | Firebase console → Project settings → Service accounts → Generate key |
| `MP_ACCESS_TOKEN`          | credencial de TESTE por enquanto            | trocar por LIVE só na homologação                                     |
| `MP_WEBHOOK_SECRET`        | segredo do webhook MP                       | reconfigurar webhook com a URL de prod (Fase 5)                       |
| `MP_TEST_PAYER_EMAIL`      | manter enquanto usar credencial TESTE       | **vazio/remover** quando virar LIVE                                   |

E as **vars** (não-secret) no `wrangler.jsonc` (🤖):

- `ALLOWED_ORIGINS`: adicionar as URLs finais do web e do driver (ex.: `https://delivery-web.<sub>.workers.dev,https://delivery-driver.<sub>.workers.dev`) — manter localhost junto para dev? **Não**: `wrangler dev` usa os `vars` locais; separar por env se necessário (`env.production.vars`).
- `MP_PUBLIC_KEY`: public key de TESTE do MP.
- `PUBLIC_API_URL`: URL final da API (necessária pro webhook MP).

## Fase 3 — R2 (mídia)

1. 🖐 Habilitar R2 na conta Cloudflare (exige cartão mesmo no free).
2. 🤖 `wrangler r2 bucket create delivo-media`.
3. Nada a mudar no código (binding `BUCKET` já aponta pra `delivo-media`).
4. ⚠️ Carry-forward relevante: `/media` serve por chave não-adivinhável **sem ACL** — aceitável pra teste; revisar antes de produção real (fotos de devolução).

## Fase 4 — Deploy da API + frontends

1. 🤖 API: `pnpm --filter @delivery/api deploy` → anotar `https://delivery-api.<sub>.workers.dev`.
2. 🤖 Smoke: `curl /health` e `curl /health/db` (prova Worker→Hyperdrive→Neon).
3. 🤖 Frontends: criar `apps/web/.env.production` e `apps/driver/.env.production`:
   ```
   VITE_API_URL=https://delivery-api.<sub>.workers.dev
   # web também:
   VITE_MP_PUBLIC_KEY=<public key TESTE>
   # driver também (config pública Firebase, já conhecida do SW):
   VITE_FIREBASE_API_KEY=...
   VITE_FIREBASE_PROJECT_ID=delivery-573f0
   VITE_FIREBASE_SENDER_ID=396629807095
   VITE_FIREBASE_APP_ID=...
   VITE_FIREBASE_VAPID_KEY=<Cloud Messaging → Web Push certificates>
   ```
4. 🤖 `pnpm --filter @delivery/web deploy` e `pnpm --filter @delivery/driver deploy`.
5. 🤖 Voltar na Fase 2 e ajustar `ALLOWED_ORIGINS` com as URLs reais + redeploy API.
6. 🖐 (Opcional, recomendado cedo) **Domínio próprio**: Workers → Custom Domains (ex.: `api.delivo.app`, `app.delivo.app`, `entregador.delivo.app`). Evita retrabalho de origins/webhook/OAuth depois. Se usar, todas as URLs das fases 5–6 usam o domínio final.

## Fase 5 — Mercado Pago (webhook em prod)

1. 🖐 No painel MP (aplicação de TESTE): configurar webhook para `https://<api>/webhooks/mercadopago` (conferir path real na rota `webhooks`), copiar o secret → `MP_WEBHOOK_SECRET` (Fase 2).
2. 🤖 Smoke: pagamento PIX de teste ponta-a-ponta no web deployado (criar pedido → QR → aprovar no sandbox → status muda).
3. 📋 Backlog homologação LIVE (fora deste doc): credenciais LIVE, remover `MP_TEST_PAYER_EMAIL`, validar estorno real.

## Fase 6 — Firebase/FCM (push do driver)

1. 🖐 Firebase console → Cloud Messaging: garantir **Web Push certificate** (VAPID key) — vai no `.env.production` do driver e o SW já tem a config pública.
2. 🖐 Gerar service account JSON → secret `FIREBASE_SERVICE_ACCOUNT` (Fase 2).
3. 🤖 Smoke: no driver deployado, "Ativar alertas" → disparar dispatch de teste → notificação chega com aba fechada.
4. ⚠️ Limite conhecido: push web só com navegador vivo; push confiável de verdade = Plano 9 (Capacitor).

## Fase 7 — Login Google (⚠️ é FEATURE, não config)

Carry-forward do plano Auth: estrutura multi-provider pronta (`auth_providers`, enum PASSWORD/GOOGLE), **mas não há rota nem fluxo implementado**. Dois blocos:

1. 🖐 **GCP Console:** criar OAuth Client ID (tipo Web), origins = URLs do web/driver, redirect = URL de callback da API (definir no design abaixo). Anotar `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`.
2. 🤖 **Implementação (mini-plano próprio antes de codar):**
   - rota `GET /auth/google` (redirect) + `GET /auth/google/callback` (code→token→profile) OU fluxo one-tap/ID-token no front + `POST /auth/google` validando o ID token;
   - vincular por email em `auth_providers` (criar user CUSTOMER se não existir; NÃO auto-criar DRIVER/STORE);
   - emitir os mesmos JWT+refresh do fluxo senha;
   - secrets `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` no Worker;
   - testes de rota (token inválido, email já existente com senha, criação nova).
   - Recomendação: fluxo ID-token (Google Identity Services no front) — sem redirect no Worker, menos estado.

## Fase 8 — Deploy contínuo (Task 10 da fundação, nunca feita)

1. 🖐 Cloudflare → API Token (template "Edit Cloudflare Workers") + Account ID.
2. 🤖 `gh secret set CLOUDFLARE_API_TOKEN` / `gh secret set CLOUDFLARE_ACCOUNT_ID`.
3. 🤖 Criar `.github/workflows/deploy.yml` (esqueleto pronto na fundação Task 10, `docs/superpowers/plans/2026-07-06-fundacao-projeto.md`): on push main → gate (typecheck+test+lint+build) → deploy api, web, driver. Atenção: testes da API exigem Postgres → usar service container no job (igual ci.yml).

## Fase 9 — Hardening mínimo pra abrir pra testers (antes de divulgar)

Do `docs/carry-forwards.md`, os que viram bloqueadores quando a URL fica pública:

| Item                                                        | Ação                                                                       | Esforço                       |
| ----------------------------------------------------------- | -------------------------------------------------------------------------- | ----------------------------- |
| `/docs` + `/openapi.json` abertos                           | gate por env var (desligar em prod) ou auth admin                          | pequeno 🤖                    |
| Rate limit login/register                                   | Cloudflare WAF rate rule (🖐, zero código) ou middleware KV                | pequeno                       |
| `/media` sem ACL                                            | mínimo: manter chave não-adivinhável; ideal: checar auth por tipo de mídia | médio 🤖                      |
| Aprovação de driver: falta ação admin (PATCH status→ACTIVE) | rota admin + botão                                                         | pequeno 🤖 (hoje: SQL manual) |
| Marca dividida Delivo vs `@delivery/*`/titles/worker names  | decidir nome antes de divulgar URL                                         | decisão 🖐 + rename 🤖        |
| JWT window de 15min p/ BLOCKED                              | aceito por ora                                                             | —                             |
| Timing oracle no login                                      | aceito por ora                                                             | —                             |

## Fase 10 — Smoke E2E completo em prod (checklist final)

1. Cadastro cliente → pedido PIX teste → loja aceita → dispatch → driver (turno por vínculo!) → entrega → ledger ok.
2. Cenário multi-vínculo: fixo manhã + oferta noite na mesma loja, dois turnos no dia, duas diárias.
3. Autorização de atraso + reajuste com aceite no app real.
4. Push com aba fechada (driver).
5. Cron: conferir logs do Worker (`wrangler tail`) — expiração de pedidos/pagamentos e auto-aprovação de diárias rodando a cada 5min.

---

## Resumo do que é 🖐 manual (lista pro Otávio)

1. Conta/projeto Neon + connection string.
2. `wrangler hyperdrive create` (ou me passar a connection string que o executor roda).
3. Habilitar R2 (cartão na conta Cloudflare).
4. Valores dos secrets: JWT novo, service account Firebase, credenciais MP, VAPID key.
5. Webhook no painel MP com URL de prod.
6. OAuth Client no GCP (quando atacar a Fase 7).
7. API Token Cloudflare + Account ID pro GitHub Actions.
8. Decisões: domínio próprio agora ou `workers.dev`? Nome definitivo (Delivo?) antes de divulgar?

## Fora de escopo deste doc

- Credenciais MP LIVE + homologação de pagamentos reais.
- Capacitor/Android (Plano 9).
- Multi-fuso, trigger moddatetime, presigned R2, demais carry-forwards não-bloqueantes.
