# Carry-forwards (pendências técnicas conscientes)

| Item | Origem | Dono futuro |
|---|---|---|
| GPS do início do turno confia no device; detecção de mock/root ainda não existe | Plano ④a | Plano 9 (Capacitor/anti-fraude) |
| GPS de “cheguei na loja” é best-effort e apenas auditado no evento; detecção de mock/root ainda não existe | Emenda Devolução | Plano 9 (Capacitor/anti-fraude) |
| Meia-taxa cobre apenas freelance; entregador fixo mantém a diária do turno | Emenda Devolução | Decisão aceita |
| Devolução nunca é autoconfirmada; loja ou suporte precisam confirmar manualmente | Emenda Devolução | Decisão aceita |
| Fotos de devolução são servidas por chave não-adivinhável em `/media`, mas sem ACL; revisar acesso/autorização no deploy | Melhorias Devolução/Ganhos | Hardening pré-produção |
| Data operacional do turno usa `America/Sao_Paulo`; lojas em outros fusos exigirão timezone por loja | Review Plano ④a | Antes de expansão multi-fuso |
| Escala avançada com valor e horário diferentes por dia exige termos financeiros por item da agenda e editor próprio | Plano ④a-2 | Evolução futura de escalas |
| Pacote: coleta exige TODOS os pedidos READY (sem coleta parcial) | Plano ③ | Se lojas pedirem coleta parcial |
| `orders.batchId` sem FK declarada (integridade no service, segue padrão de `driverId`) | Plano ③ | Hardening/deploy |
| apps/driver duplica lib/api.ts + stores/auth.ts do web (cópia deliberada) — extrair pra package shared quando doer | Plano Dispatch T8 | Oportunista |
| FCM: 1 token por entregador (último dispositivo vence); sem retry/cleanup de tokens inválidos | Plano Dispatch T13 | Plano Capacitor |
| Re-broadcast automático (3-5min) + alerta à loja (10min sem aceite) não implementados — broadcast é a lista viva + FCM one-shot | Plano Dispatch | Plano 8/hardening (cron existe, falta canal loja) |
| Recorrência avançada de vagas (ex.: 1ª segunda do mês) está fora do MVP; semanal e datas específicas estão prontas | Plano ④c | Se houver demanda |
| Ofertas não enviam push; o entregador descobre novas vagas pela aba “Vagas” | Plano ④c | Avaliar FCM após validar uso |
| `updatedAt` via `$onUpdate` é ORM-level; raw SQL bypassa. Avaliar trigger `moddatetime` | Review Task 4 | Plano Financeiro (ledger) |
| `viewport-fit=cover` no index.html do driver (notch Android) | Review Task 6 | Plano Capacitor |
| vitest node pool: rotas que usam `c.env` dependem de mock; avaliar `@cloudflare/vitest-pool-workers` | Reviews Tasks 3/4 | Quando integração real precisar |
| Enforcement do factory `createRouter()` via lint rule (`no-restricted-syntax`) | Review Task 3 | Oportunista |
| Deploy prod (Tasks 9-10 do plano): Neon + Hyperdrive id + secrets + deploy.yml | Skip do usuário | Quando tiver contas |
| Marca dividida: repo "Delivo" vs interno "Delivery" (`@delivery/*`, titles, openapi, worker names) — unificar antes do público | Review final | Antes do deploy prod |
| Barrel `@delivery/shared` (".") re-exporta schema zod — frontend importando barrel puxa zod de volta; considerar `no-restricted-imports` | Review final | Oportunista |
| SEC-03A passou no gate local; smoke real allowlisted do Resend/Turnstile em staging privado segue `NOT RUN`. Código remediado não equivale a produção aprovada | SEC-03A Stage 4 | Preparação de staging |
| SEC-03B Google não implementado — criar Web Client ID no GCP, validar ID token/`sub`, criar CUSTOMER novo e usar link ticket + senha para colisão com conta PASSWORD; nunca vincular só por email | Security remediation design | Plano SEC-03B |
| SEC-17 MFA opcional não implementado — TOTP, código por email, recovery codes e step-up para ações de risco | Security remediation design | Plano SEC-17 |
| Password storage permanece PBKDF2-HMAC-SHA256/100k; benchmark, versão de hash e rehash progressivo/alternativa compatível com Workers seguem pendentes | SEC-09 / SEC-03A | Hardening de credenciais |
| Resend bounce/complaint/suppression webhook não implementado; staging restrito exige monitoramento manual e produção ampla exige webhook assinado/idempotente + suppression local | SEC-03A | Antes de envio amplo |
| Produção de email exige domínio próprio, SPF/DKIM/DMARC, `EMAIL_FROM` verificado e remoção de `EMAIL_ALLOWED_RECIPIENTS` | SEC-03A | Promoção de produção |
| `@types/node` + "node" no tsconfig types cobrem src+test juntos — globais node (process/Buffer) ficam type-visíveis em src que deploya no Workers; considerar tsconfig.test.json separado | Review Auth T3 | Oportunista |
| JWT_SECRET de produção via `wrangler secret put JWT_SECRET` (dev usa .dev.vars) | Plano Auth | Task 9 fundação (deploy prod) |
| api.ts força Content-Type application/json quando há body — quebraria upload FormData/multipart se reusado; hoje só JSON | Review Auth T10 | Quando houver upload (plano Catálogo) |
| `/auth/me` devolve claims do token `{sub,role,name}` em vez do user canônico `{id,...,status,phone,email}` + OpenAPI usa `role: z.string()` não o enum — web não consome hoje; ajustar quando um cliente protegido usar /auth/me | Review final Auth | Plano que consumir /auth/me |
| Bucket R2 `delivo-media` real não criado — dev usa storage local do wrangler; criar via `wrangler r2 bucket create delivo-media` no deploy prod | Plano Lojas T4 | Deploy prod (Task 9 fundação) |
| Logo upload passa pelo Worker (limite 2MB ok p/ logo); fotos de produto em volume podem justificar presigned URL direto ao R2 | Plano Lojas T7 | Plano Produtos se necessário |
| Home ordena abertas-primeiro no client; com muitas lojas mover ordenação/paginação pro SQL | Plano Lojas T11 | Quando lista crescer |
| Re-upload de logo deixa objeto R2 órfão (chave antiga nunca deletada) — leak lento de storage | Review Lojas T7 | Limpeza futura (cron ou delete no upload) |
| Admin UI: toggleActive sem try/catch (falha silenciosa em erro de API) | Review Lojas T9 | Plano Admin & Relatórios |
| Fotos de produto: mesma nota do logo — órfãos no re-upload; volume maior que logos | Plano Produtos | Junto da limpeza de logos |
| Import CSV não importa variações/adicionais (só categoria+produto+preço) — ajuste fino manual | Plano Produtos T8 | Aceito (decisão de escopo) |
| Busca FTS sem paginação/ranking fino (limit 30) | Plano Produtos T7 | Quando catálogo crescer |
| Busca: FTS side ainda sensível a acento (só ILIKE tem unaccent) + sem índice em unaccent(name) — ok em escala atual | Review Prod T5 | Quando catálogo crescer |
| minMenuPrice ignora FLAVOR-only (produto só-sabores mostra "a partir de" pela base) — by-spec, revisar exibição | Review Prod T2 | Plano Design/UX |
| Painel: swap de ordenação usa índices do array como sortIndex — gaps podem gerar empate momentâneo | Review Prod T9 | Oportunista |
| Repreço de matriz sabor×variação (FLAVOR×VARIATION) segue só no editor completo do produto (replace-all); pausar/repreçar granular cobre produto + opções de preço simples | Plano Controle da Loja | Se lojas pedirem edição rápida da matriz |
| Modal: checkbox acima do max não re-renderiza (desync visual, preço correto) + produto indisponível abre modal | Review Prod T11 | Plano Pedidos (cart) |
| Amendment só REDUZ itens (não adiciona/troca) — adicionar item = pedido novo | Plano 5b | Se lojas pedirem |
| Amendment em pedido cash: diferença só informativa (cobra novo total na porta) | Plano 5b | Aceito |
| Beep da loja depende de aba aberta + polling 15s — FCM/push real no Plano 6 | Plano Pedidos | Plano 6 |
| Re-notificação da loja (10/20min) antes do auto-cancel 30min não implementada (só o cancel) — precisa canal de push | Plano Pedidos | Plano 6 (FCM) |
| isFirstOrder faz 1 query por pedido da fila (N+1) — ok em cidade pequena | Plano Pedidos T6 | Se fila crescer |
| listCustomerOrders/listStoreOrders sem paginação real (limit fixo) | Plano Pedidos | Quando volume crescer |
| Pool/aceite do driver não é gated em isAvailable (toggle afeta só FCM+UI) — driver indisponível ainda pode aceitar via API. Design aceito; endurecer se virar problema | Audit Plano 6 | Se comportamento incomodar |
| Cron auto-cancel de PENDING não notifica entregador se houver atribuição legada; após fix A o estado é inatingível, linha de defesa mantida | Fix pós-Plano 6 | N/A (estado inválido bloqueado) |
| MP: integração usa Payments API clássica (/v1/payments, webhook "Pagamentos (legacy)") — MP empurra novas integrações pra Orders API; migrar se a clássica for deprecada | Plano 7 setup | Monitorar avisos do MP |
| Pagamentos centralizados na conta MP da plataforma — split nativo/automação = fases futuras (ver runbook) | Plano 7 | Plano 8 (ledger) + futuro split |
| Webhook exige URL pública (PUBLIC_API_URL) — em dev usar tunnel (cloudflared) ou confirmar via reconsulta; produção resolve no deploy CF | Plano 7 | Deploy prod |
| Cartão: MVP 1x sem parcelamento; sem 3DS challenge flow | Plano 7 | Se recusas indicarem necessidade |
| Tracking não tem botão "regenerar PIX" após expirar — cliente refaz o pedido | Plano 7 | UX futura |
| Alertas do driver: avaliar FCM-only (push-to-sync: refetch em push/focus/online, toast global via store de eventos, notificationclick no SW, guard permissão↔disponibilidade, polling lento 60-120s de segurança ou remoção total) — SUJEITO a validação de necessidade em testes reais no Capacitor; WebSocket descartado (FCM já é push persistente) | Discussão pós-Plano 7 | Plano 9 (Capacitor) |
| Polling em 1s (todas as telas) — escolha pra testes locais; RECALIBRAR antes de prod (1s × N usuários = carga alta; valores anteriores: 10-15s) | Ajuste dev 2026-07-10 | Antes do deploy prod |
| Estorno parcial (amendment) roda PÓS-commit: se gateway falhar, amendment fica APPROVED sem estorno e sem flag "estorno devido" — replay manual é seguro (idempotency key `refund-{id}-{cents}`), mas não há retry automático nem consulta de pendências | Plano 5b (audit) | Plano 8 (ledger/reconciliação) |
| Ledger de DELIVERED agora é atômico com a transição; outros efeitos externos pós-commit ainda dependem de retry/reconciliação | Plano 8 + Emenda Devolução | Hardening/reconciliação |
| DELIVERY_FAILED cash/maquininha freelance: frete é liberado na devolução sem débito da loja; plataforma absorve por decisão de negócio | Emenda Devolução | Decisão aceita |
| `markStoreInvoicePaid`/`markStorePayoutPaid`/`markDriverPayoutPaid` sem guard `status='OPEN'` — remarcar sobrescreve `paidAt`. Menor | Plano 8 (audit) | Oportunista |
| Comissão não é snapshotada na entry do ledger (só o valor final é congelado) — perde trilha da alíquota usada | Plano 8 (audit) | Se auditoria fiscal exigir |
| Pacote com TODOS os pedidos cancelados fica órfão ACCEPTED (loja não cancela mais; driver só faz release → volta ao pool mostrando "0 entregas") — cosmético, sem risco de dinheiro | Plano ③ (audit) | Hardening (auto-cancelar pacote vazio) |
| Escala AVANÇADA do entregador próprio: valor (diária/extra) e horário DIFERENTES por dia da semana — hoje 1 valor + 1 horário por vínculo aplicado aos dias marcados. Precisa valor por item da agenda + editor rico | Decisão pós-④a | Plano futuro dedicado |
