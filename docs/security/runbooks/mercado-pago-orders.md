# Runbook — Mercado Pago Orders

## Arquitetura

Checkout cria tentativa local antes do provider. Mercado Pago Orders é consultado por HTTP bounded. Webhooks `type=order` validam HMAC, persistem inbox deduplicado e respondem após persistência; processamento ocorre assíncrono. Cancelamentos/refunds viram `payment_operations` idempotentes. Cron executa reconciliação bounded.

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
