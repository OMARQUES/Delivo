# Runbook — Mercado Pago Orders

## Arquitetura

Checkout cria tentativa local antes do provider. PIX e cartão online recebem deadline comum de 30 minutos. Mercado Pago Orders é consultado por HTTP bounded. Webhooks `type=order` validam HMAC, persistem inbox deduplicado e respondem após persistência; processamento ocorre assíncrono com cliente DB próprio. Cancelamentos/refunds viram `payment_operations` idempotentes. Cron executa stages em ordem `leases → dependencies → inbox → creates → snapshots → expirations → operations → reviews`.

## Configuração não secreta

- `MP_APPLICATION_ID`: application ID esperado pelo ambiente.
- `MP_ACCOUNT_ID`: account ID esperado pelo ambiente.
- `MP_LIVE_MODE=false`: sandbox/local; `true` somente em ambiente aprovado.
- `MP_ACCESS_TOKEN` e `MP_WEBHOOK_SECRET`: apenas Worker secrets; nunca vars/Git.

## Preflight de credenciais

Confirmar token novo, escopo correto, conta/application esperados e modo sandbox/live. Nunca imprimir valor. Validar provider `getAccountId()` antes de trabalho financeiro. Rotacionar segredo em caso de exposição.

## Verificação local

```bash
pnpm --filter @delivery/api test -- mercadopago.test.ts payment-reconciliation.test.ts payment-operation.service.test.ts webhooks.routes.test.ts
pnpm --filter @delivery/api exec tsc --noEmit
pnpm --filter @delivery/api test
```

Usar somente fixtures sandbox. Não usar cartão/conta de produção. Não enviar webhook real neste procedimento.

## Status sanitizado

```bash
psql "$DATABASE_URL" -f apps/api/scripts/payment-work-status.sql
```

Saída permitida: status, failure class, contagem e idade. Proibido selecionar body provider, email, QR, token, senha ou URL com credencial.

## Requeue manual

Somente operador autorizado, após investigar causa:

```bash
psql -v work_type=inbox -v work_id=UUID -f apps/api/scripts/requeue-payment-work.sql
psql -v work_type=operation -v work_id=UUID -f apps/api/scripts/requeue-payment-work.sql
```

Script aceita apenas linha `REVIEW_REQUIRED`; preserva idempotency/business key e histórico de tentativas.

## Failure classes

- `CREATE_REQUIRES_RECOVERY`: create `402`/`409`; pesquisar pela referência e confirmar por `GET` autoritativo.
- `MUTATION_REQUIRES_READ`, `RESOURCE_LOCKED`, `TRANSIENT_UNCERTAIN`, `PROVIDER_UNAVAILABLE`, `RATE_LIMITED`: retry bounded.
- `ORDER_NOT_FOUND`: review/recheck limitado.
- `CREDENTIAL_OR_CONFIG`, `MISMATCH_*`, `UNSUPPORTED_*`, `CHARGEBACK`: review manual.
- `RETRY_EXHAUSTED`: parar e investigar; não repetir cegamente.

Inbox e pagamentos usam `retryDisposition` com máximo de 8 tentativas; a oitava falha persiste `REVIEW_REQUIRED/RETRY_EXHAUSTED` e não agenda uma nona. Pagamentos mantêm `reconciliation_attempt_count` não negativo e resetam o contador somente após transição autoritativa.

## Reconciliação e recovery de create incerto

- `RECOVERED`: snapshot único aplicado; `lastReconciledAt` atualizado.
- `AMBIGUOUS_PROVIDER_CREATE`: múltiplos Orders para mesma referência; mantém pagamento em `REVIEW_REQUIRED`, sem novo create.
- `RETRY_CARD`: nenhum resultado para CARD; mantém `PENDING` e repete somente search/GET dentro do limite. Nunca recria cobrança nem reutiliza token.
- `RETRY_PIX`: nenhum resultado para PIX ainda válido, ou falha transitória; mantém `PENDING` e agenda nova tentativa limitada.
- Create PIX incerto de pedido `CANCELLED`: busca exata permitida; zero resultados nunca recriam Order/cobrança.
- Pagamento `AWAITING_PAYMENT` vencido (PIX ou cartão): reconciliação cancela comercialmente pedido e cria intenção canônica `cancel:{paymentId}:ORDER_CANCELLED` quando há Order no provider. Sem `providerOrderId`, não há mutação externa.
- Cancelamento manual e expiração usam mesma intenção canônica; operação durable executa `CANCEL`, confirma por `GET Order`, e escala para `REFUND_FULL` se houver aprovação tardia.
- Após commit `CANCELLED`, nenhum snapshot, webhook, create recovery ou cron pode reabrir/liberar pedido.

Não registrar email, token, QR, provider ID, idempotency key ou corpo de erro. Summaries de cron carregam somente contagens.

## Cancelamento seguro de AWAITING_PAYMENT

- PIX e cartão expiram comercialmente após 30 minutos; cron de cinco minutos pode iniciar resolução entre 30 e 35 minutos.
- Cancelamento manual usa `POST /orders/{id}/cancel`. Pedido vira `CANCELLED` antes de I/O com provedor.
- Pagamento pendente converge por `CANCEL`; aprovação concorrente/tardia converge por `REFUND_FULL`.
- `processing/in_process` pode recusar cancelamento; manter trabalho retryable e confirmar somente por `GET Order` autoritativo.
- `NOT_CHARGED` = estado autoritativo cancelado/rejeitado/expirado sem captura. `REFUNDED` = estorno total autoritativo.
- Oitava falha gera `REVIEW_REQUIRED/RETRY_EXHAUSTED`; pedido permanece cancelado e exige inspeção antes de requeue.
- Create incerto de pedido já cancelado é somente busca: nunca recriar Order PIX/cartão.

Inspeção sanitizada:

```bash
psql "$DATABASE_URL" -f apps/api/scripts/payment-work-status.sql
```

Requeue somente após confirmar identidade, valor, ambiente, método e estado autoritativo:

```bash
psql "$DATABASE_URL" \
  -v work_type=operation \
  -v work_id=UUID \
  -f apps/api/scripts/requeue-payment-work.sql
```

Nunca registrar corpo do provider, payload PIX, email, token, credencial ou identificador integral na evidência.

## HTTP outcome recovery

| Outcome | Recovery |
| --- | --- |
| create 402/409 | exact-reference search, authoritative GET, then validate |
| create 423/429/5xx/network | search-first bounded reconciliation |
| mutation 2xx/409/uncertain | authoritative GET before settlement |
| deterministic 400/401/403 | configuration/review; no unchanged retry |
| unknown/contradictory snapshot | fail closed in REVIEW_REQUIRED |

CARD tokens nunca são persistidos nem repetidos. Create sem resultado fica pendente até recuperação bounded ou `RETRY_EXHAUSTED`. `Retry-After` aceita delta ou data HTTP, limitado a seis horas. Uma recusa confirmada deve resultar em pagamento `REJECTED/HEALTHY`, IDs do provider presentes e pedido `CANCELLED`. Logs e evidências nunca incluem corpo bruto do provider.

Após merge, executar manualmente no sandbox, nesta ordem:

1. cartão aprovado;
2. cartão de teste `OTHE/rejected_by_issuer` recusado;
3. criação de QR PIX;
4. webhook assinado usando o ID real da Order sandbox correspondente;
5. cancelamento;
6. expiração de PIX/cartão em `AWAITING_PAYMENT` e confirmação de que loja não recebe pedido;
7. refund total e parcial, quando permitidos pela conta sandbox;
8. inspeção por `apps/api/scripts/payment-work-status.sql`;
9. inspeção sanitizada dos logs.

## Cadeia de dependências

Antes de claim outbound, reconciliador propaga predecessor `REVIEW_REQUIRED` somente a filhos acionáveis e converge em batches dentro do orçamento total. Inspecionar apenas contagem e idade:

```sql
select status, failure_class, count(*) as count,
       floor(extract(epoch from (now() - min(created_at)))/60)::int as oldest_minutes
from payment_operations
group by status, failure_class;
```

`SUCCEEDED`/`CANCELLED` não significam conclusão financeira até refund dependente terminar com sucesso. Refund full usa alvo exato do pagamento; partial usa soma cumulativa já observada + novo valor, nunca excedendo total.

Recheck seguro usa somente `ORDER_NOT_FOUND`, `PROVIDER_UNAVAILABLE` e `TRANSIENT_UNCERTAIN`, com intervalo bounded. Mismatch, credencial, ambiente e chargeback ficam para revisão manual.

## Alertas

Alertar por contagem/idade, sem conteúdo sensível:

- qualquer `REVIEW_REQUIRED` financeiro;
- inbox/operation pendente acima de 5 minutos;
- aumento de `TRANSIENT_UNCERTAIN`/`PROVIDER_UNAVAILABLE`;
- `CREDENTIAL_OR_CONFIG` > 0;
- retry exhaustion > 0.

## Rollback

Parar cron/reconciler, manter inbox/operations intactos, desabilitar checkout online por configuração e preservar cancel/refund intent. Não apagar pagamentos nem reverter migration. Requeue somente após causa corrigida.

## Limite staging

Este runbook cobre validação local e operação interna. Smoke externo de webhook Mercado Pago, sandbox/live, domínio, produção e credenciais reais não é autorizado por este plano.
