# Carry-forwards (pendências técnicas conscientes)

| Item | Origem | Dono futuro |
|---|---|---|
| `updatedAt` via `$onUpdate` é ORM-level; raw SQL bypassa. Avaliar trigger `moddatetime` | Review Task 4 | Plano Financeiro (ledger) |
| `/docs` + `/openapi.json` expostos sem gate | Review Task 3 | Task 9 (deploy prod) |
| Slugs reservados (`loja`, `admin`, etc.) — validar na criação de loja | Review Task 5 | Plano Catálogo |
| `viewport-fit=cover` no index.html do driver (notch Android) | Review Task 6 | Plano Capacitor |
| vitest node pool: rotas que usam `c.env` dependem de mock; avaliar `@cloudflare/vitest-pool-workers` | Reviews Tasks 3/4 | Quando integração real precisar |
| Enforcement do factory `createRouter()` via lint rule (`no-restricted-syntax`) | Review Task 3 | Oportunista |
| Deploy prod (Tasks 9-10 do plano): Neon + Hyperdrive id + secrets + deploy.yml | Skip do usuário | Quando tiver contas |
| Marca dividida: repo "Delivo" vs interno "Delivery" (`@delivery/*`, titles, openapi, worker names) — unificar antes do público | Review final | Antes do deploy prod |
| Barrel `@delivery/shared` (".") re-exporta schema zod — frontend importando barrel puxa zod de volta; considerar `no-restricted-imports` | Review final | Oportunista |
| Google OAuth não implementado — falta OAuth client no Google Cloud Console (GOOGLE_CLIENT_ID/SECRET); estrutura multi-provider pronta (authProviders table, provider enum PASSWORD/GOOGLE) | Plano Auth T12 (pulado) | Quando tiver credenciais GCP |
| `@types/node` + "node" no tsconfig types cobrem src+test juntos — globais node (process/Buffer) ficam type-visíveis em src que deploya no Workers; considerar tsconfig.test.json separado | Review Auth T3 | Oportunista |
| Login timing oracle: usuário inexistente pula PBKDF2 (resposta rápida) vs senha errada (PBKDF2 ~lento) — distingue existência de conta apesar da mesma mensagem. Baixo impacto (app cidade pequena). Fix: dummy-verify em hash fixo no path de usuário não-encontrado | Review Auth T7 | Hardening pré-prod se enumeração virar risco |
| `requireRole` implementado+testado mas ainda não montado em nenhuma rota real (só no unit test) — será montado nos planos Admin/Loja | Auth T8 | Planos Admin/Loja |
| Rate limiting em /auth/login e /auth/register (anti brute-force) | Plano Auth | Hardening pré-prod |
| JWT_SECRET de produção via `wrangler secret put JWT_SECRET` (dev usa .dev.vars) | Plano Auth | Task 9 fundação (deploy prod) |
| Usuário BLOCKED com access token válido tem janela de até 15min (TTL do access) antes do bloqueio surtir efeito | Plano Auth | Aceito — revisar se virar problema |
| Aprovação de entregador: login já bloqueia PENDING com mensagem; falta ação admin de aprovar (PATCH status→ACTIVE) | Plano Auth | Plano Admin |
| api.ts força Content-Type application/json quando há body — quebraria upload FormData/multipart se reusado; hoje só JSON | Review Auth T10 | Quando houver upload (plano Catálogo) |
