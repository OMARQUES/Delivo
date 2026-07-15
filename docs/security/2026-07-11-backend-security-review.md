# Revisão de segurança do backend — 2026-07-11

## Remediação P0 — concluída

Plano executado: `docs/superpowers/plans/2026-07-11-p0-authorization-session-foundation.md`. As 10 tasks foram implementadas em ciclo TDD no worktree `feat/p0-authorization-session`. Gate final verde: shared 89 testes, API 45 arquivos/367 testes, typecheck e ESLint sem erros, `git diff --check` limpo.

| Achado | Estado P0 | Evidência implementada | Limite remanescente |
| --- | --- | --- | --- |
| SEC-01 | Remediado | CUSTOMER obrigatório em `/orders*` e `/me/addresses*`; matriz exaustiva ANON/CUSTOMER/DRIVER/STORE/ADMIN sobre todas as rotas protegidas em `authorization-matrix.routes.test.ts`. | — |
| SEC-02 | Remediado em código | PostgreSQL rate limits atômicos por IP/identidade/fingerprint/ator/propósito; Turnstile obrigatório em cadastro e adaptativo em login; proteção de refresh, cotação/criação de pedido e uploads antes de trabalho caro/R2; limpeza por cron. | WAF Cloudflare e smoke real de Turnstile/staging dependem de recursos externos. |
| SEC-03 | Remediado em código | SEC-03A tornou identidade email-first, verificação obrigatória, recovery não enumerável, códigos/tickets hash-only, Resend/outbox e ativação segura de STORE/ADMIN. Matriz final cobre ANON/CUSTOMER/DRIVER/STORE_A/STORE_B/ADMIN e varredura de segredos persistidos/logados; gate local final passou em 2026-07-13. | Smoke real allowlisted em staging não executado: ambiente nomeado/credenciais externos ainda indisponíveis. Domínio/DNS/remetente verificado seguem obrigatórios para produção. SEC-03B Google, SEC-17 MFA, modernização do hash e webhooks Resend permanecem pendentes. |
| SEC-04 | Remediado | JWT completo (`iss/aud/nbf/jti/sid/ver`) e principal vivo consultado no PostgreSQL a cada request; revogação por família e por `tokenVersion`. | MFA e identidade verificada continuam fora do P0. |
| SEC-05 | Remediado | `securityStatus` ACTIVE/SUSPENDED/CLOSED; suspensão incrementa `tokenVersion` do dono, revoga refresh e bloqueia descoberta pública. | — |
| SEC-06 | Mitigação emergencial | `/media/*` só serve `logos/` e `products/`; `returns/` não consulta R2. | Leitura privada autenticada, retenção e auditoria pertencem ao plano de mídia privada. |
| SEC-07 | Remediado | DTOs explícitos de entrega ativa/histórico removem spreads de `orders` e PII do histórico do entregador; mutações de entregador respondem só `{id,status}`. | Projeções de loja/admin (`listStoreOrders`, `listPendingReturns`) seguem fora deste plano por design. |
| SEC-12 | Parcialmente remediado | Limites de corpo global (6 MiB), JSON (256 KiB), upload com leitura limitada por streaming, content type explícito e quotas de frequência em fluxos caros. | Deadlines externos e limites de custo de provedores seguem pendentes. |
| SEC-20 | Parcialmente remediado | Headers defensivos, `no-store` em superfícies sensíveis, HSTS só em produção e docs/OpenAPI/health DB restritos a `APP_ENV=local`. | Políticas de borda Cloudflare e staging seguem em fase própria. |

Contratos negativos cross-tenant e transições de evento de segurança (logout, logout-all, bloqueio de conta, suspensão de loja) verificados em `authorization-boundary.routes.test.ts`: leituras de recurso alheio retornam `404`; mutações escopadas por dono afetam 0 linhas e rejeitam com `404`/`409` sem vazar existência.

Desvios do plano registrados: a emissão/rotação de tokens permaneceu em `auth.service.ts` (o plano sugeria mover para `security-session.service.ts`); a organização de arquivo difere mas as propriedades de segurança — claims completos, vínculo de família, revogação viva — são idênticas e cobertas por teste.

SEC-03A concluiu o gate local automatizado da Stage 4, Task 9. A validação operacional externa permanece aberta: WAF/Turnstile/Resend reais em staging dependem de configuração Cloudflare/Resend manual. SEC-08 está remediado em código; validação externa Orders/sandbox/live permanece pendente. A mídia privada completa também permanece pendente; esta tabela não declara a auditoria inteira resolvida nem autoriza produção.

### Remediação SEC-02 — 2026-07-12

Plano executado: `docs/superpowers/plans/2026-07-11-sec-02-rate-limiting.md`, tasks 1–13, no worktree `feat/sec-02-rate-limiting`.

Evidência implementada:

- `rate_limit_buckets` com contador atômico PostgreSQL e cleanup cron limitado;
- chaves HMAC por escopo e tipo de sujeito, sem armazenar email/telefone/IP/token bruto;
- respostas de abuso estáveis com `code` e `Retry-After` bounded;
- `/auth/register` protegido por Turnstile + limite por IP/identidade;
- `/auth/login` com limite por IP, falhas por identidade, Turnstile adaptativo após falhas e cooldown sem lockout permanente;
- `/auth/refresh` limitado por fingerprint/IP antes da rotação;
- `/orders/quote` e `POST /orders` limitados antes de serviços/pagamento;
- uploads de logo, produto e evidência de devolução limitados após auth/ownership e antes de ler body/R2;
- web e driver suportam Turnstile de cadastro e login adaptativo.

Gates executados:

- `DATABASE_URL=postgres://postgres:postgres@localhost:5432/delivery pnpm --filter @delivery/api db:migrate`;
- suites focadas SEC-02: shared 16 arquivos/97 testes; API 51 arquivos/448 testes; web 6 arquivos/18 testes; driver 4 arquivos/5 testes;
- gate completo: `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm build`, `git diff --check`.

Pendências explícitas:

- regra WAF Free para `/auth/*` só pode ser ativada após Cloudflare zone/domínio;
- smoke real de Turnstile staging/produção depende de widgets e secrets reais;
- webhook anti-replay/rate controls implementados no hardening Orders; smoke externo segue pendente;
- verificação de email, recuperação e limites de códigos foram implementados no SEC-03A; gate local passou e staging externo segue pendente.

### Remediação SEC-03A — gate local concluído

Plano executado até Stage 4, Task 9: `docs/superpowers/plans/2026-07-12-sec-03a-implementation-index.md`.

Implementado em código:

- email obrigatório, normalizado e verificado para contas PASSWORD;
- cadastro destacado: nenhum usuário/sessão existe antes da confirmação;
- CUSTOMER ativo após confirmação; DRIVER segue para `PENDING_APPROVAL` sem sessão;
- recuperação com envelope não enumerável, ticket efêmero hash-only, troca atômica de senha e revogação de todas as sessões;
- códigos numéricos de seis dígitos derivados/verificados por HMAC, com TTL, tentativas, cooldown e rate limits por propósito;
- Resend com timeout, erros sanitizados, allowlist de staging e outbox idempotente/retry por cron;
- STORE provisionada sem senha do owner, `PENDING_ACTIVATION`, setup por ticket e ativação atômica;
- ADMIN bootstrap singleton por CLI, `PENDING_EMAIL`, sem imprimir segredo/PII;
- login e convite de entregador somente por email; convite exige DRIVER ativo e verificado;
- testes de autorização/tenant para STORE_A/STORE_B e varredura recursiva contra senha, código, ticket, token, Turnstile e API key crus em DB/logs.

Evidência Stage 4, Task 9 em 2026-07-13, código-base `78143da`:

- Postgres Docker local exclusivo da worktree; `delivery` e `delivery_test` recriados sem tocar volume do ambiente principal;
- 26 migrations aplicadas do zero; `0024_sec_03a_foundation` e `0025_sec_03a_email_identity` sucederam `0023`;
- seed com config local fictícia e destinatário bloqueado pela allowlist: ADMIN `PENDING_EMAIL`, email não verificado, zero refresh tokens e nenhuma chamada ao Resend;
- suíte focada/completa: shared 18 arquivos/125 testes; API 69/649; web 14/54; driver 6/15 — 843 testes, zero falhas;
- `pnpm typecheck`, `pnpm lint`, `pnpm build` e `git diff --check` passaram;
- scanner bruto retornou somente dois controles negativos em testes sobre rejeição de senha do owner; scanner excluindo testes retornou zero bypass em produção;
- documentação/runbook: `docs/security/runbooks/sec-03a-resend-identity.md`;
- smoke real Resend/Turnstile: **NOT RUN** — `env.staging` nomeado, credenciais e recursos externos ainda não existem.

SEC-03A recebe estado “Remediado em código”, não “validado em staging” nem “pronto para produção”. Produção continua bloqueada até staging privado allowlisted e domínio/DNS/remetente verificado. Pendências separadas: SEC-03B Google, SEC-17 MFA opcional, password-storage modernization e webhooks Resend de bounce/complaint/suppression.

### Revisão independente pós-implementação — 2026-07-11

Revisão do código final encontrou e corrigiu sete lacunas não cobertas pelo primeiro gate:

1. Loja `SUSPENDED`/`CLOSED` ainda conseguia autenticar e criar uma nova família que poderia funcionar após reativação. Login e refresh agora consultam `stores.securityStatus` antes de emitir credenciais.
2. Bloquear e reativar um entregador ressuscitava access/refresh antigos. A transição para `BLOCKED` agora incrementa `tokenVersion` e revoga famílias na mesma transação.
3. Bloqueio de entregador não removia disponibilidade nem destino FCM. Ambos são limpos atomicamente, e atualizações concorrentes de perfil usam o mesmo lock de usuário.
4. Duas alterações administrativas concorrentes podiam violar a terminalidade de `CLOSED`. A linha da loja agora usa `FOR UPDATE` antes de validar a transição.
5. Ausência de `APP_ENV` era interpretada como `local`, expondo docs/OpenAPI/health DB. O comportamento agora é fail-closed.
6. Corpo JSON sem `Content-Type` atravessava validação e podia causar `500`. Requests com corpo em rotas JSON agora recebem `415`; limites de 256 KiB/6 MiB têm testes diretos.
7. `tokenVersion` era opcional no emissor e aparecia nas respostas de auth. Claims de versão/família agora são obrigatórias no tipo, e o campo interno foi removido dos DTOs públicos.

Gate pós-revisão: shared 89 testes, API 45 arquivos/377 testes e web 14 testes; typecheck, ESLint, builds web/driver e `git diff --check` passaram. UI permaneceu fora do escopo: telas administrativas que ainda usam `isActive` e visualização pública de evidências privadas precisam ser compatibilizadas nos planos correspondentes antes de staging operacional completo.

## Sumário executivo

Esta revisão encontrou uma base razoável de autorização por papel e de isolamento por loja, mas a aplicação **não está pronta para ser considerada segura em produção**. Não foi encontrada uma forma direta de uma loja autenticada ler ou alterar objetos de outra loja nas rotas específicas de loja revisadas. Contudo, existem falhas de autorização horizontal/funcional fora desse núcleo, exposição pública de evidências privadas, controles de autenticação insuficientes e riscos de integridade financeira.

Resultado por severidade:

| Severidade | Quantidade | Leitura                                                                             |
| ---------- | ---------: | ----------------------------------------------------------------------------------- |
| Crítica    |          0 | Nenhum bypass total de autenticação ou acesso administrativo direto foi confirmado. |
| Alta       |          8 | Corrigir antes de produção ou de ampliar usuários reais.                            |
| Média      |         10 | Corrigir logo após o bloco P0; algumas amplificam as altas.                         |
| Baixa      |          4 | Hardening e redução de superfície/informação.                                       |

Os maiores riscos confirmados são:

1. Qualquer usuário autenticado — inclusive `DRIVER`, `STORE` e `ADMIN` — pode usar as rotas de endereços e pedidos de cliente.
2. Cadastro e login não têm rate limiting, anti-automação ou prova de posse do telefone/email.
3. Fotos de devolução são servidas sem autenticação pela mesma rota pública de logos e produtos.
4. O JWT é aceito sem consultar o estado atual da conta; bloqueio, mudança de papel e logout não revogam o access token vigente.
5. Uma loja marcada como inativa continua acessando e operando todas as rotas autenticadas de loja.
6. Respostas para entregadores espalham a linha inteira do pedido e mantêm PII do cliente disponível no histórico.
7. Confirmação de pagamento não é atômica e não valida valor, moeda e referência externa retornados pelo provedor.
8. Contas privilegiadas de loja/admin usam apenas senha, sem MFA, reautenticação ou trilha de auditoria administrativa.

## Escopo e método

Foram revisados:

- todos os arquivos em `apps/api/src/routes` e o registro global em `apps/api/src/app.ts`;
- middlewares de autenticação, banco e erro;
- serviços de auth, pedidos, catálogo, dispatch, pacotes, vínculos, ofertas, turnos, devoluções, financeiro e pagamentos;
- schemas Drizzle, migrations e schemas Zod compartilhados;
- JWT, refresh tokens, armazenamento de senha, Mercado Pago, FCM, R2, cron, CORS e configuração de segredos;
- testes de rota/serviço e dependências de produção.

Validação dinâmica executada:

- `pnpm --filter @delivery/api test`: **41 arquivos e 227 testes passaram**;
- `pnpm audit --prod --audit-level low`: **nenhuma vulnerabilidade conhecida reportada**;
- varredura textual do código rastreado por padrões de segredos: nenhum segredo de produção confirmado; `.env` e `.dev.vars` não estão rastreados e constam no `.gitignore`.

Limitações:

- não houve pentest contra ambiente publicado;
- WAF, regras Cloudflare, configuração real do Hyperdrive/Neon, TLS, backups, IAM e segredos de produção não puderam ser comprovados pelo repositório;
- histórico Git não foi submetido a scanner especializado de segredos;
- UI foi excluída conforme solicitado;
- `pnpm audit` só detecta advisories conhecidos e não substitui análise lógica.

Referências de controle usadas: [OWASP REST Security](https://cheatsheetseries.owasp.org/cheatsheets/REST_Security_Cheat_Sheet.html), [OWASP Authentication](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html), [OWASP Password Storage](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html), [OWASP File Upload](https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html), [OWASP API Security Top 10 2023](https://owasp.org/API-Security/editions/2023/en/0x10-api-security-risks/) e [NIST SP 800-63B-4](https://pages.nist.gov/800-63-4/sp800-63b.html).

## Matriz de autorização e isolamento

| Superfície           | Proteção encontrada           | Isolamento do objeto                                              | Resultado                                                                      |
| -------------------- | ----------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `/admin/*`           | JWT + `requireRole('ADMIN')`  | acesso global intencional                                         | Papel correto; falta MFA, sessão forte e auditoria.                            |
| `/store/*`           | JWT + `requireRole('STORE')`  | `storeId` é derivado de `auth.sub`; serviços filtram pela loja    | **Nenhum acesso direto loja A→B encontrado.**                                  |
| `/driver/*`          | JWT + `requireRole('DRIVER')` | serviços filtram por `driverUserId`, turno, vínculo ou atribuição | Separação de papel boa; há excesso de PII nas projeções.                       |
| `/orders*`           | somente JWT                   | objetos filtrados por `customerId = auth.sub`                     | Isola usuários, mas **não exige papel CUSTOMER**.                              |
| `/me/addresses*`     | somente JWT                   | objetos filtrados por `userId = auth.sub`                         | Isola usuários, mas **não exige papel CUSTOMER**.                              |
| `/auth/me`           | JWT                           | próprio subject do token                                          | Não consulta estado atual da conta.                                            |
| `/media/*`           | nenhuma                       | chave do R2 fornecida pelo cliente                                | Logos/produtos públicos e evidências privadas misturados.                      |
| lojas/cardápio/busca | pública intencional           | somente lojas ativas                                              | Adequado para descoberta pública.                                              |
| health/docs/OpenAPI  | pública                       | n/a                                                               | Baixo risco; superfície desnecessária em produção.                             |
| webhook Mercado Pago Orders | HMAC + inbox deduplicado + reconsulta bounded | `providerOrderId`/`externalReference` | Código remediado; smoke externo e credenciais reais pendentes. |

### Pontos positivos confirmados

- Algoritmo JWT é fixado em `HS256`; `alg=none` não é aceito.
- Access token expira em 15 minutos.
- Refresh token tem 256 bits aleatórios, é armazenado apenas como hash, rotacionado e organizado por família.
- Erros de senha no login usam mensagem genérica.
- Rotas de loja obtêm a loja pelo owner do token, em vez de aceitar `storeId` arbitrário no corpo.
- Catálogo, ofertas, vínculos, turnos, pacotes, pedidos, devoluções e financeiro aplicam filtro de loja nos pontos revisados.
- Rotas de entregador verificam atribuição, vínculo, turno ou `driverUserId` antes de mutar pedidos.
- SQL é construído por Drizzle/queries parametrizadas; nenhuma injeção SQL confirmada.
- Handler global não devolve stack trace ao cliente.
- CORS usa allowlist exata e não habilita credenciais.
- Nomes de upload são UUIDs e os tipos declarados usam allowlist.
- Webhook valida HMAC em tempo constante e reconsulta o pagamento no provedor em vez de confiar no corpo.
- Ledger usa chaves únicas/idempotentes em vários lançamentos.

## Achados altos

### SEC-01 — Rotas de cliente aceitam qualquer papel

**Severidade:** Alta
**Categoria:** Broken Function Level Authorization / abuso de fluxo de negócio
**Evidência:** `apps/api/src/routes/addresses.ts:10`; `apps/api/src/routes/orders.ts:24-25`

`/me/addresses*` e `/orders*` aplicam somente `authMiddleware`. Não aplicam `requireRole('CUSTOMER')`. Portanto, um token legítimo `DRIVER`, `STORE` ou `ADMIN` pode criar endereço, cotar/criar pedido, listar seus pedidos e operar cancelamentos/alterações como se fosse cliente.

O filtro `customerId = auth.sub` evita ler pedidos de outro usuário, mas não resolve a autorização funcional. O banco também não garante que `orders.customer_id` ou `customer_addresses.user_id` apontem para um usuário `CUSTOMER`.

**Impacto:** pedidos fraudulentos ou operacionais criados por contas privilegiadas; acesso indevido a pagamentos online; confusão contábil; possibilidade de uma loja gerar pedidos para si; quebra explícita da separação de papéis solicitada.

**Correção robusta:** aplicar `authMiddleware, requireRole('CUSTOMER')` aos dois grupos; centralizar a política por namespace; adicionar teste matricial para ANON/CUSTOMER/DRIVER/STORE/ADMIN em toda rota. No serviço de criação, validar também a situação atual do usuário como defesa em profundidade.

### SEC-02 — Login, cadastro e fluxos caros sem rate limiting/anti-automação

**Severidade:** Alta
**Categoria:** Credential stuffing, brute force, fake accounts, resource exhaustion
**Evidência:** ausência de middleware de limite em `apps/api/src/app.ts` e `apps/api/src/routes/auth.ts`

Não existe limite global, por IP, por identificador, por conta ou por dispositivo em `/auth/login`, `/auth/register`, `/auth/refresh`, criação de pedidos, uploads ou webhook. O login executa PBKDF2 e pode ser usado para consumir CPU. Cadastro imediato de clientes e criação de pedidos podem ser automatizados para poluir banco e operação da loja.

O [OWASP Authentication Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html) recomenda defesa em profundidade contra brute force, credential stuffing e password spraying. O [OWASP API4:2023](https://owasp.org/API-Security/editions/2023/en/0xa4-unrestricted-resource-consumption/) inclui limites de frequência, tamanho, memória e custos de terceiros.

**Correção robusta:** duas camadas. Na borda Cloudflare, limite por IP/ASN e proteção contra bots. Na aplicação, contador por identidade normalizada + IP/dispositivo, atraso exponencial e `429` genérico. Não usar bloqueio permanente simples por conta, pois permite DoS contra a vítima. Exigir Turnstile/challenge após risco ou tentativas. Limitar também cadastro, refresh, pedidos, uploads e chamadas que acionam terceiros.

### SEC-03 — Cadastro não prova posse de telefone ou email

**Severidade:** Alta
**Categoria:** Account pre-hijacking / identity squatting
**Evidência:** `packages/shared/src/auth.schema.ts:8-16`; `apps/api/src/services/auth.service.ts:58-112`

> Estado em 2026-07-13: achado histórico da baseline. SEC-03A substituiu este fluxo por cadastro email-first destacado, verificação obrigatória e recovery não enumerável. Gate local concluído; staging externo permanece pendente. Ver “Remediação SEC-03A — gate local concluído”.

O cliente fica `ACTIVE` e recebe tokens assim que fornece um telefone e senha. Não existe OTP por telefone, link por email ou outra prova de posse. Um atacante pode cadastrar o telefone/email de outra pessoa antes dela, bloquear seu cadastro legítimo e operar sob aquela identidade declarada. Para driver, a aprovação administrativa não prova que o telefone pertence ao candidato.

O cadastro ainda retorna `409 Telefone ou email já cadastrado`, permitindo enumeração direta. No login, a mensagem é genérica, mas usuário inexistente não executa PBKDF2 enquanto senha errada executa, criando diferença temporal.

**Correção robusta:** criar identidade pendente com expiração; enviar desafio de uso único, armazenado como hash, com TTL, limite de tentativas e limite de reenvio; ativar somente após confirmação. Driver só entra na fila de aprovação depois da verificação. Evitar reserva eterna: liberar identidade pendente expirada. Uniformizar resposta/tempo quando razoável.

### SEC-04 — Estado atual da conta não participa da autorização do access token

**Severidade:** Alta
**Categoria:** Session revocation / stale authorization
**Evidência:** `apps/api/src/middleware/auth.ts:7-16`; `apps/api/src/lib/tokens.ts:3-17`

O middleware verifica assinatura e expiração, mas não carrega o usuário. `role`, `name` e autorização vêm integralmente do JWT. Consequências:

- driver bloqueado continua operando até o access token expirar;
- eventual mudança de papel só passa a valer após novo token;
- logout revoga refresh tokens, mas o access token continua válido por até 15 minutos;
- tokens de usuários removidos continuam válidos até expirar;
- não existe `jti`, `iss`, `aud`, `nbf` ou versão de sessão/credencial.

O OWASP recomenda validar claims padronizados e tratar a desconexão entre JWT e estado atual da sessão em [REST Security](https://cheatsheetseries.owasp.org/cheatsheets/REST_Security_Cheat_Sheet.html).

**Correção robusta:** incluir `iss`, `aud`, `jti` e `tokenVersion`; validar todos. Em cada requisição sensível, carregar uma projeção pequena do usuário (`status`, `role`, `tokenVersion`) com cache curto seguro, ou usar sessão opaca. Incrementar `tokenVersion` em bloqueio, troca de senha, mudança de papel, logout global e incidente. Para logout imediato por dispositivo, manter denylist do `jti` até `exp` ou usar access token ainda mais curto.

### SEC-05 — Loja desativada pelo admin continua com acesso operacional completo

**Severidade:** Alta
**Categoria:** Revogação incompleta / broken business authorization
**Evidência:** `apps/api/src/db/schema/stores.ts:45-46`; `apps/api/src/services/store.service.ts:106-108`; middlewares `/store/*`

O schema descreve `isActive=false` como loja “bloqueada pelo admin”. Porém `getStoreByOwner` não exige `isActive`, e nenhuma rota autenticada de loja verifica esse campo. A loja some da descoberta e o checkout público é negado, mas o owner ainda pode ler pedidos e dados de clientes, alterar catálogo/configuração, operar pedidos existentes, publicar ofertas, manipular vínculos/turnos e consultar financeiro.

**Correção robusta:** separar estados sem ambiguidade: `operationalStatus` (pausada/fechada) e `securityStatus` (ativa/suspensa/encerrada). Middleware de loja deve rejeitar conta ou loja suspensa. Definir explicitamente quais ações de encerramento ainda são permitidas, por exemplo somente leitura financeira e suporte, e revogar sessões na suspensão.

### SEC-06 — Evidências de devolução são públicas e cacheadas por um ano

**Severidade:** Alta
**Categoria:** Broken Object Level Authorization / exposição de dados pessoais
**Evidência:** `apps/api/src/routes/media.ts:4-14`; chaves `returns/*` em `apps/api/src/routes/driver.ts:362-389`

A mesma rota pública serve logos, fotos de produto e fotos de devolução. A chave UUID reduz descoberta aleatória, mas não constitui autorização. Qualquer pessoa que obtenha ou receba a URL consegue acessar a evidência sem login. A resposta usa `Cache-Control: public, max-age=31536000, immutable`, dificultando revogação e remoção em caches.

**Impacto:** vazamento de imagem, endereço, embalagem, interior de imóvel ou outras evidências ligadas a cliente/entregador; risco LGPD.

**Correção robusta:** separar bucket/prefixo público de privado. Logos/produtos permanecem públicos. Evidências devem ser entregues por endpoint autenticado que resolve um ID lógico e verifica admin, loja dona ou entregador atribuído; usar URL assinada de curtíssima duração, `Cache-Control: private, no-store`, auditoria de leitura e política de retenção/exclusão.

### SEC-07 — Entregador recebe campos excessivos do pedido e PII após conclusão

**Severidade:** Alta
**Categoria:** Broken Object Property Level Authorization / minimização LGPD
**Evidência:** `apps/api/src/services/dispatch.service.ts`, funções `driverOrderDetail` e `listDriverDeliveries`

As respostas usam `...row.order`, expondo toda a linha `orders` ao entregador atribuído. Isso inclui campos que não são necessários à entrega, como `customerId`, `taxId`, chaves de foto de devolução, IDs internos, dados de cancelamento e outros metadados. O histórico concluído continua retornando nome, telefone, endereço, referência e coordenadas do cliente.

O vínculo ao entregador está corretamente verificado; o problema é propriedade/ciclo de vida dos dados, não acesso a pedidos aleatórios.

**Correção robusta:** DTOs explícitos por estado. Durante entrega ativa, retornar somente dados necessários. Após `DELIVERED`, remover telefone, referência e coordenadas imediatamente ou após janela operacional curta. Nunca retornar `taxId` ao driver. Evitar qualquer spread de entidade de banco em respostas externas.

### SEC-08 — Pagamento confirmado sem atomicidade e sem vínculo financeiro completo

**Estado atual:** remediado em código no hardening Mercado Pago Orders. Validação externa de assinatura, credenciais, sandbox/live e webhook permanece pendente; produção continua bloqueada.

**Severidade:** Alta
**Categoria:** Integridade financeira / unsafe consumption of API
**Evidência:** `apps/api/src/services/payment.service.ts:79-107`; `apps/api/src/lib/mercadopago.ts:87-90`

`confirmPaymentApproved` grava `payments.status=APPROVED`, depois altera o pedido e depois cria evento, sem transação única. Se o processo falhar entre esses passos, nova notificação retorna cedo porque o pagamento já está `APPROVED`, deixando pedido e pagamento inconsistentes.

A reconsulta ao Mercado Pago confirma apenas `id` e `status`. A aplicação não compara `transaction_amount`, moeda, `external_reference`, recebedor/conta e ambiente com o pagamento/pedido local. A assinatura do webhook protege a origem da notificação, mas não substitui a validação do objeto financeiro retornado.

**Correção robusta:** o adapter deve retornar status, valor, moeda, referência externa e merchant/account. Comparar tudo com a linha local. Fazer claim e transição local numa transação com lock/compare-and-set; registrar inbox de webhook por event/request ID; usar outbox/reconciliação para efeitos externos. Criar job periódico que reconcilia `payment`, `order` e provedor.

## Achados médios

### SEC-09 — Senhas abaixo do baseline atual e sem upgrade automático

**Severidade:** Média

PBKDF2-HMAC-SHA256 usa 100.000 iterações (`apps/api/src/lib/password.ts:5`); o [OWASP Password Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html) recomenda 600.000 para PBKDF2-HMAC-SHA256. Senha mínima é 8 para autenticação de fator único; o [NIST SP 800-63B-4](https://pages.nist.gov/800-63-4/sp800-63b.html) estabelece 15 caracteres para senha usada como único fator e recomenda blocklist de senhas comuns/comprometidas.

O formato versionado permite migração, mas o login não rehasha hashes antigos. A máquina local auditada usa senha admin de 10 caracteres; o valor não foi exposto no relatório.

**Correção:** preferir provedor de identidade/passkeys ou Argon2id em ambiente apropriado. Se Workers exigir WebCrypto PBKDF2, benchmarkar 600k no plano de CPU antes de ativar; adotar rehash-on-login, senha mínima 15 sem regras artificiais de composição, blocklist, pepper em secret manager e MFA obrigatório para privilégios.

### SEC-10 — Cadastro de usuário e credencial não é transacional

**Severidade:** Média

`registerUser` insere `users`, calcula o hash e insere `authProviders` fora de uma transação. Falha de CPU, rede ou banco após o primeiro insert deixa usuário sem credencial, mas telefone/email continuam únicos e ocupados. Isso transforma falha operacional em negação persistente de cadastro e amplifica pre-hijacking.

**Correção:** calcular hash antes ou dentro de fluxo controlado e inserir usuário + provider + aceite/versionamento de termos numa única transação. Tratar conflitos apenas pela constraint, sem precheck dependente de corrida.

### SEC-11 — Corrida no refresh e sessões ilimitadas

**Severidade:** Média

Dois refreshes exatamente concorrentes podem ambos ler `usedAt=null`. O vencedor rotaciona; o perdedor recebe erro porque o `UPDATE ... usedAt is null` não alterou linha, mas esse caminho não revoga a família. Se o vencedor for quem roubou o token, a sessão comprometida permanece válida. Além disso, cada login cria nova família sem limite, listagem, expiração antecipada por inatividade ou limpeza observável.

**Correção:** transação com lock/claim atômico; se o claim falhar, revogar a família conhecida. Limitar sessões ativas, oferecer revogação por dispositivo e global, armazenar metadados mínimos de sessão, limpar expiradas e alertar reuso.

### SEC-12 — Sem limite global de corpo, custo e tempo externo

**Severidade:** Média

Não existe middleware global de tamanho. JSON e CSV podem ser materializados antes de rejeição. O CSV limita linhas, mas não bytes nem comprimento por linha. Uploads validam `byteLength` depois de `arrayBuffer()`, portanto o corpo já ocupou memória. Chamadas a Mercado Pago, Google OAuth/FCM não definem timeout explícito.

**Correção:** rejeitar por `Content-Length` quando presente e aplicar limite real de stream/corpo com `413`; limites específicos por rota; bytes máximos no CSV; deadlines com `AbortSignal.timeout`; limites de concorrência e orçamento de terceiros.

### SEC-13 — Upload confia no Content-Type e pode deixar objetos órfãos

**Severidade:** Média

Logo, produto e devolução aceitam o MIME declarado pelo cliente. Não há validação de magic bytes, decode seguro ou re-encode. Em logo/produto, o objeto é gravado no R2 antes da confirmação de ownership/update e não é removido se essa etapa falhar, permitindo consumo de storage por chamadas autenticadas repetidas com IDs inválidos.

O [OWASP File Upload Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html) diz para não confiar no `Content-Type`, validar assinatura, limitar tamanho e controlar leitura.

**Correção:** verificar ownership antes do upload; validar assinatura e decodificar/re-encodar; gerar formato seguro; excluir objeto em qualquer falha; quotas por tenant; limpeza de órfãos; bucket privado para evidência.

### SEC-14 — Sem headers globais de segurança e cache de respostas sensíveis

**Severidade:** Média

Não há `secureHeaders`. Respostas autenticadas não definem `Cache-Control: no-store`; também faltam `X-Content-Type-Options`, HSTS e proteção de framing no nível da aplicação. Cloudflare pode fornecer alguns em produção, mas isso não está demonstrado no repo.

**Correção:** middleware global com headers do [OWASP REST Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/REST_Security_Cheat_Sheet.html); `no-store` em auth, pedidos, endereços, driver, loja, admin e financeiro; HSTS somente em HTTPS/produção; CSP restritiva para `/docs` ou remover docs públicas.

### SEC-15 — Webhook não limita replay nem custo

**Severidade:** Média

O `ts` participa do HMAC, mas não é validado contra uma janela de tempo. Uma requisição assinada capturada pode ser repetida indefinidamente. Não há deduplicação persistente por request/event ID nem rate limit. Cada replay válido pode provocar reconsulta externa. A implementação segue o manifesto documentado pelo [Mercado Pago](https://www.mercadopago.com.br/developers/en/docs/mp-point/notifications), mas precisa de controles locais adicionais.

**Correção:** aceitar `ts` somente dentro de pequena tolerância, persistir/deduplicar request/event ID, limitar frequência, responder rápido e processar por inbox/fila idempotente. Manter reconsulta ao provedor.

### SEC-16 — Isolamento depende integralmente de filtros da aplicação

**Severidade:** Média

Não há Row-Level Security ou policies nas migrations. O usuário de banco usado pela aplicação aparenta ter acesso amplo. Hoje os filtros de loja revisados estão corretos, mas um único endpoint futuro sem `storeId` pode expor todos os tenants.

**Correção:** criar camada/repositório tenant-aware que torne impossível consultar recurso de loja sem `tenantId`; testes de contrato; considerar PostgreSQL RLS usando contexto transacional por tenant ou, no mínimo, roles separadas e privilégios mínimos. Admin/jobs devem usar caminho explicitamente privilegiado.

### SEC-17 — Contas privilegiadas sem MFA, step-up ou auditoria imutável

**Severidade:** Média (impacto potencial alto)

Admin e loja usam o mesmo login de senha dos clientes. Não existe MFA/passkey, reautenticação para comissão/pagamentos/status, restrição de rede, sessão administrativa separada ou trilha de auditoria dedicada. Eventos de pedido não substituem auditoria de login, bloqueio, criação/desativação de loja, comissão, fechamento financeiro, marcação de pago e confirmação de devolução.

**Correção:** MFA resistente a phishing para admin e obrigatório ao menos TOTP/passkey para loja; step-up em ações financeiras; painel admin em hostname/política separada; audit log append-only com ator, tenant, alvo, antes/depois, request ID, IP aproximado, resultado e timestamp; alertas de comportamento.

### SEC-18 — Ciclo de credencial incompleto

**Severidade:** Média

Não há troca de senha, “esqueci minha senha”, confirmação de alteração de email/telefone, logout de todos os dispositivos ou resposta a credencial comprometida. A recuperação manual tende a criar processos inseguros fora do sistema.

**Correção:** fluxo de recuperação com tokens aleatórios de uso único, hash no banco, TTL curto, rate limit, resposta não enumerável e revogação de todas as sessões; exigir senha atual ou step-up para mudanças; notificar canal anterior quando identidade mudar.

## Achados baixos

### SEC-19 — Enumeração de entregadores por loja

`inviteDriver` diferencia “não encontrado” de “não é entregador ativo”. Qualquer conta STORE consegue testar telefones. Uniformizar resposta e, preferencialmente, usar convite consentido/identificador não enumerável.

### SEC-20 — Docs, OpenAPI e saúde do banco são públicos

`/docs`, `/openapi.json` e `/health/db` estão públicos. Isso não cria acesso por si só, mas facilita reconhecimento e revela disponibilidade do banco. Em produção, restringir docs a rede/admin ou publicar especificação sanitizada; health detalhado deve ficar no monitoramento interno.

### SEC-21 — Configuração de segredos sem validação forte e arquivos locais permissivos

`.env` e `.dev.vars` estão corretamente ignorados e não rastreados. Porém os arquivos locais estavam com modo `0644`, legíveis por outros usuários da máquina. Não há validação de entropia/comprimento de `JWT_SECRET` ou separação/rotação por ambiente no código. O segredo JWT local não era o placeholder, mas sua entropia real não pode ser inferida pelo comprimento.

**Correção:** `chmod 600`; secret manager/Wrangler secrets; ao menos 256 bits aleatórios para HMAC; segredos distintos por ambiente; rotação documentada com `kid`; validação de configuração fail-closed no startup/deploy; scanner de segredos no pre-commit e CI.

### SEC-22 — Aceite de termos não registra versão

O cadastro grava somente timestamp. Para prova e compliance, registrar versão/hash do documento, canal e timestamp; evitar IP bruto salvo sem necessidade/política.

## Plano recomendado de correção

### P0 — bloquear produção/ampliação

1. Exigir `CUSTOMER` em `/orders*` e `/me/addresses*`; criar matriz automática de autorização para todas as rotas.
2. Implantar rate limiting de borda + aplicação em auth, cadastro, refresh, pedidos, uploads e webhook.
3. Redesenhar cadastro com verificação de telefone/email e transação atômica.
4. Consultar estado atual/tokenVersion no middleware; revogar sessões em bloqueio/suspensão/logout global.
5. Fazer `isActive/securityStatus` de loja bloquear o conjunto definido de rotas.
6. Separar mídia pública e evidência privada; remover cache público de devoluções.
7. Criar DTOs explícitos de driver e remover PII desnecessária/histórica.
8. Tornar confirmação de pagamento atômica, validar valor/moeda/referência/merchant e implantar reconciliação.

### P1 — identidade e defesa em profundidade

1. MFA/passkeys para admin e loja; step-up financeiro.
2. Atualizar hashing e política de senha com rehash progressivo.
3. Implementar recuperação/troca de credencial e gestão de sessões.
4. Corrigir corrida de refresh e limitar famílias ativas.
5. Limitar corpo/stream, timeouts, quotas e custos externos.
6. Validar/re-encodar uploads e limpar órfãos.
7. Headers globais, `no-store` e política CORS testada por ambiente.
8. Audit log append-only e alertas.

### P2 — arquitetura de isolamento e operação

1. Repositório tenant-aware e avaliação de PostgreSQL RLS/privilégio mínimo.
2. Pentest autenticado com STORE A/STORE B/DRIVER/CUSTOMER/ADMIN.
3. DAST em staging e SAST/secret scanning/SCA no CI.
4. Retenção e anonimização de PII, fotos e logs conforme finalidade.
5. Restringir docs/health; runbooks de incidente, rotação e reconciliação financeira.

## Testes de segurança obrigatórios a adicionar

Uma suíte table-driven deve enumerar cada endpoint e executar, conforme aplicável, ANON, CUSTOMER, DRIVER, STORE_A, STORE_B e ADMIN. Além disso:

- `DRIVER/STORE/ADMIN` recebem `403` em todos os `/orders*` e `/me/addresses*`;
- STORE_A recebe `404` e não altera nenhum objeto de STORE_B em catálogo, pedido, pacote, oferta, vínculo, turno, autorização, devolução e financeiro;
- DRIVER_A não lê/muta entrega, turno, vínculo, payout ou devolução de DRIVER_B;
- CUSTOMER_A não lê/muta endereço, pedido, pagamento ou amendment de CUSTOMER_B;
- token emitido antes de `BLOCKED`, suspensão de loja, troca de papel/senha ou logout global falha imediatamente;
- refresh concorrente/reutilizado revoga toda a família;
- cadastro concorrente/falho não deixa usuário órfão;
- rate limit responde `429` sem revelar existência da conta;
- foto de devolução falha para anônimo, cliente e loja alheia; URL expira e não é cacheável;
- upload com MIME falso, magic bytes inválidos, corpo acima do limite e ID alheio não persiste objeto;
- webhook velho, duplicado, valor/moeda/referência divergente e corrida não alteram pedido;
- falha induzida entre payment/order/event é recuperada por transação/reconciliação;
- resposta do driver nunca contém `taxId` e remove PII após conclusão;
- loja suspensa não opera rotas proibidas;
- corpos JSON/CSV enormes são rejeitados antes de materialização completa.

## Veredito

O isolamento **loja A contra loja B** está bem aplicado nas rotas atuais e possui matriz negativa explícita para STORE_A/STORE_B. Após P0 + SEC-02 + implementação SEC-03A, RBAC central, sessão viva, anti-automação, verificação de email e recovery estão substancialmente melhores. SEC-03A passou no gate local, mas ainda depende do smoke Resend/Turnstile em staging; Google/MFA não fazem parte deste fechamento. Mídia privada e consistência de pagamento também exigem correção antes de uso real em escala.

Após o P0, recomenda-se uma segunda revisão focada nas mudanças e um pentest autenticado em staging. Até lá, a classificação recomendada é: **risco alto; não aprovar produção com dados/pagamentos reais sem mitigação**.
