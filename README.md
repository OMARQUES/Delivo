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
pnpm dev:api     # http://localhost:8787 (docs em /docs)
pnpm dev:web     # http://localhost:5173
pnpm dev:driver  # http://localhost:5174
```

### Bootstrap seguro do primeiro ADMIN

Configure `DATABASE_URL`, `APP_ENV`, `ADMIN_EMAIL`, `ADMIN_NAME`, `AUTH_CODE_SECRET`,
`RESEND_API_KEY`, `EMAIL_FROM`, `PUBLIC_WEB_URL` e, em staging, `EMAIL_ALLOWED_RECIPIENTS`
no `apps/api/.env`. Forneça senha de 15–128 caracteres por variável temporária, evitando
argumentos CLI e histórico do shell:

```bash
read -rsp 'Senha inicial do ADMIN: ' ADMIN_PASSWORD && printf '\n'
export ADMIN_PASSWORD
pnpm --filter @delivery/api db:seed
unset ADMIN_PASSWORD
```

Comando cria somente um ADMIN `PENDING_EMAIL` e envia código de ativação. Confirmação
não cria sessão; depois dela, faça login normal com email e senha. Reexecução com mesmo
email/senha reenvia após cooldown de 60 segundos enquanto ativação estiver pendente;
ADMIN já ativo vira no-op. Saída contém somente estado e status de entrega — nunca email,
senha, código ou ID de verificação. Operação completa e rollback:
`docs/security/runbooks/sec-03a-resend-identity.md`.

Auth já funciona por email: cadastro exige verificação antes de criar conta/sessão, login é email+senha e recovery revoga sessões anteriores. Telefone do CUSTOMER é opcional; DRIVER informa telefone para contato e ainda exige aprovação administrativa. Guards por role protegem `/loja` e `/admin`. Admin cria lojas em `/admin/lojas` sem escolher senha do owner e aprova entregadores em `/admin/entregadores`. Cardápio da loja em `/loja/cardapio`; import CSV: `POST /admin/stores/:id/catalog/import` (text/csv). Fluxo de pedido completo: cliente pede, loja gerencia em `/loja/pedidos`, solicita entregador, e o app driver aceita/coleta/entrega.

Entregadores próprios: a loja convida pelo email verificado de um DRIVER `ACTIVE` em `/loja/entregadores`; telefone continua somente como contato. O entregador confirma em “Minhas lojas”, inicia o turno próximo à loja e passa a receber somente o broadcast daquela loja. Mudanças nos termos exigem confirmação. Pedidos e pacotes podem ir ao pool, a todos os próprios ou a um entregador específico; recusas nunca causam fallback automático. A loja também pode reajustar um turno ativo e reconciliar o extra retroativo pelo ledger.

Falhas de entrega ficam destacadas em uma seção própria de devoluções. O entregador pode declarar a devolução na loja e anexar até duas fotos de evidência; o pagamento só é liberado quando loja ou suporte confirmam. Em Ganhos, lançamentos exibem data/hora e abrem um detalhe do pedido sanitizado, sem dados do cliente.

## Verificação

```bash
pnpm typecheck && pnpm test && pnpm lint && pnpm build
```

## Deploy (pendente — runbook)

Deploy prod ainda não executado. Gate local SEC-03A Task 9 concluído; próximo passo é staging privado allowlisted conforme `docs/security/runbooks/sec-03a-resend-identity.md`. Depois seguir Tasks 9-10 de `docs/superpowers/plans/2026-07-06-fundacao-projeto.md` (Neon, Hyperdrive id real, Cloudflare Access, secrets, domínio/DNS Resend e deploy.yml).

## Auth

Email verificado + senha (PBKDF2); telefone não autentica. JWT de acesso + refresh token rotativo com consulta de principal/sessão viva. Google OAuth (SEC-03B) e MFA opcional (SEC-17) pendentes — ver `docs/carry-forwards.md`.

## FCM (opcional)

Backend lê `FIREBASE_PROJECT_ID` e `FIREBASE_SERVICE_ACCOUNT` em `apps/api/.dev.vars`/secrets Cloudflare. Driver lê `VITE_FIREBASE_*` em `apps/driver/.env.development`; o service worker `apps/driver/public/firebase-messaging-sw.js` contém só identificadores públicos do Firebase. Sem esses valores, dispatch segue por polling + beep.

## Mercado Pago (opcional em dev)

Backend usa `MP_ACCESS_TOKEN`, `MP_WEBHOOK_SECRET` e `PUBLIC_API_URL` em `apps/api/.dev.vars`. Web usa `VITE_MP_PUBLIC_KEY` em `apps/web/.env.development`; sem public key o cartão online fica oculto, e sem access token o checkout online retorna 503. Para testar webhook local, exponha o Worker com tunnel (ex.: cloudflared) e use essa URL em `PUBLIC_API_URL`.

## Specs e planos

- Requisitos funcionais: `docs/superpowers/specs/2026-07-06-requisitos-funcionais-design.md`
- Plano de fundação: `docs/superpowers/plans/2026-07-06-fundacao-projeto.md`
- Runbook de identidade/Resend: `docs/security/runbooks/sec-03a-resend-identity.md`
- Pendências técnicas: `docs/carry-forwards.md`

## Roadmap de planos

1. ✅ Fundação (este repo)
2. ✅ Auth — email verificado+senha, recovery, JWT + refresh, RBAC (Google/MFA pendentes)
3. ✅ Lojas & Descoberta — cadastro admin, perfil da loja (horário/frete/pin/logo), home pública, deep-link `/:slug`
4. ✅ Produtos & Cardápio — categorias, produtos, variações, adicionais, meio-a-meio, busca
5. ✅ Pedidos (core) — carrinho, checkout idempotente, máquina de status, retirada, painel loja, polling
5b. ✅ Amendment — proposta da loja, aprovação do cliente, estorno parcial
6. ✅ Dispatch — broadcast FCM, aceite com lock atômico, batching multi-loja/multi-destino, telas driver
7. ✅ Pagamentos — MP centralizado (PIX+cartão), estornos, webhook
8. ✅ Financeiro — ledger imutável, fatura de comissão, payout manual por período, extratos loja/entregador, comissão por loja definida pelo admin (`/admin/lojas`, em %)
- ✅ Controle da Loja — pausar/repreçar produto e opção ao vivo (sem replace-all), no cardápio da loja
- ✅ Pacote de Entregas — loja agrupa pedidos (1 coleta, vários destinos) e oferta ao pool; entregador coleta 1x e quebra em entregas individuais
- ✅ Entregadores Próprios (④a) — múltiplos vínculos, turno por ocorrência, autorização de atraso, reajuste confirmado e diária aprovada pela loja
- ✅ Dispatch Direcionado (④b) — pool/próprios/específico para pedidos e pacotes, recusa e escalada explícita
- ✅ Ofertas/Vagas (④c) — N vagas, recorrência semanal ou datas específicas, aceite atômico com conflito de agenda e vínculo temporário
- ✅ Devolução + Meia-taxa — estorno na falha, pagamento na devolução e compensação de deslocamento freelance
9. Capacitor — build Android driver, FCM nativo
10. Admin & Relatórios — gestão, import CSV, faturamento, mini-ERP
11. Design & Identidade Visual — marca/nome definitivo, design system, refatoração UI/UX das telas existentes

> Estratégia de UI: até o plano 10, telas são utilitárias (Tailwind cru) — foco em domínio/fluxo/API. Estética entra de uma vez no plano 11, sobre fluxos já validados.
