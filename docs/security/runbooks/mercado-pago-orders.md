# Runbook — Mercado Pago Orders

## Arquitetura

Checkout cria tentativa local antes do provider. Mercado Pago Orders é consultado por HTTP bounded. Webhooks `type=order` validam HMAC, persistem inbox deduplicado e respondem após persistência; processamento ocorre assíncrono com cliente DB próprio. Cancelamentos/refunds viram `payment_operations` idempotentes. Cron executa reconciliação bounded por stages.

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

- `TRANSIENT_UNCERTAIN`, `PROVIDER_UNAVAILABLE`, `RATE_LIMITED`: retry bounded.
- `ORDER_NOT_FOUND`: review/recheck limitado.
- `CREDENTIAL_OR_CONFIG`, `MISMATCH_*`, `UNSUPPORTED_*`, `CHARGEBACK`: review manual.
- `RETRY_EXHAUSTED`: parar e investigar; não repetir cegamente.

Inbox e pagamentos usam `retryDisposition` com máximo de 8 tentativas; a oitava falha persiste `REVIEW_REQUIRED/RETRY_EXHAUSTED` e não agenda uma nona. Pagamentos mantêm `reconciliation_attempt_count` não negativo e resetam o contador somente após transição autoritativa.

## Reconciliação e recovery de create incerto

- `RECOVERED`: snapshot único aplicado; `lastReconciledAt` atualizado.
- `AMBIGUOUS_PROVIDER_CREATE`: múltiplos Orders para mesma referência; mantém pagamento em `REVIEW_REQUIRED`, sem novo create.
- `FRESH_CARD_REQUIRED`: nenhum resultado para CARD; exige nova tentativa com token novo, sem replay do token anterior.
- `RETRY_PIX`: nenhum resultado para PIX ainda válido, ou falha transitória; mantém `PENDING` e agenda nova tentativa limitada.
- PIX expirado sem `providerOrderId`: após busca exata sem resultado, expira localmente e cancela apenas pedido `AWAITING_PAYMENT`; não cria operação CANCEL.
- PIX expirado com `providerOrderId`: somente fila durable `CANCEL` pode atuar; não expirar localmente em paralelo.

Não registrar email, token, QR, provider ID, idempotency key ou corpo de erro. Summaries de cron carregam somente contagens.

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
