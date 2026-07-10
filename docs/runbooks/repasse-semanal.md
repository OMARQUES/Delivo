# Runbook — Repasse semanal (manual, fase 1)

> **SUBSTITUÍDO (Plano 8)**: use a tela **Admin → Financeiro** (`/admin/financeiro`) para
> fechar o período (gera faturas/repasses a partir do ledger) e marcar cada documento como pago.
> Os passos SQL abaixo ficam como **fallback** / conferência. O PIX em si continua manual
> (fora do sistema) — o painel só registra e marca como pago.
> faturas de comissão saem zeradas.

Todo pagamento ONLINE (PIX/cartão) cai na conta Mercado Pago da plataforma.
Semanalmente (sugestão: segunda de manhã), repassar às lojas e entregadores.

## Passo a passo

1. **Levantar valores** (enquanto não há tela no admin — Plano 8 automatiza):
   ```sql
   -- vendas online entregues na semana, por loja (valor - comissão a definir):
   SELECT s.name, s.pix_key, SUM(o.subtotal_cents)/100.0 AS produtos_reais,
          SUM(COALESCE(o.delivery_fee_cents,0))/100.0 AS fretes_reais
   FROM orders o JOIN stores s ON s.id = o.store_id
   WHERE o.payment_method IN ('PIX_ONLINE','CARD_ONLINE')
     AND o.status = 'DELIVERED'
     AND o.created_at >= now() - interval '7 days'
   GROUP BY s.id, s.name, s.pix_key;

   -- fretes por entregador (todas as entregas da semana, qualquer método):
   SELECT u.name, d.pix_key, SUM(COALESCE(o.delivery_fee_cents,0))/100.0 AS fretes_reais
   FROM orders o JOIN users u ON u.id = o.driver_id LEFT JOIN drivers d ON d.user_id = o.driver_id
   WHERE o.status = 'DELIVERED' AND o.driver_id IS NOT NULL
     AND o.created_at >= now() - interval '7 days'
   GROUP BY u.id, u.name, d.pix_key;
   ```
2. **Calcular repasse da loja** = produtos − comissão da plataforma (percentual acordado) + fretes de pedidos SEM entregador freelance. Regra fina de frete/comissão entra no ledger (Plano 8) — até lá, planilha.
3. **Pagar**: PIX da conta Mercado Pago (ou da conta bancária da empresa) para a `pix_key` de cada um.
4. **Registrar**: anotar comprovantes na planilha da semana (data, quem, valor, id da transação).

## Regras

- Pedido `DELIVERY_FAILED` pago online: frete do entregador É devido (viagem feita); produto = decidir com a loja caso a caso (estorno já foi automático se cancelado).
- Loja/entregador sem `pix_key` cadastrada: cobrar cadastro antes do repasse.

## Evolução

- Fase 2 (Plano 8): ledger + tela de fechamento no admin gera a lista pronta.
- Fase 3: automação de envio (API PIX bancária) e/ou migração pro split nativo do MP.
