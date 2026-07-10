#!/usr/bin/env bash
# Simula o pagamento de um PIX em DEV (sandbox do MP não permite pagar PIX de teste).
# Faz o que o webhook faria: payment → APPROVED, pedido → PENDING, evento registrado.
#
# Uso:
#   ./scripts/pagar-pix-dev.sh "<código pix copia-e-cola>"
#   ./scripts/pagar-pix-dev.sh <order_id (uuid)>
#   ./scripts/pagar-pix-dev.sh            # sem args: paga o pedido AWAITING_PAYMENT mais recente
set -euo pipefail

ARG="${1:-}"

SQL=$(cat << 'EOF'
WITH target AS (
  SELECT p.id AS payment_id, p.order_id, p.status AS pay_status, o.status AS order_status
  FROM payments p
  JOIN orders o ON o.id = p.order_id
  WHERE
    CASE
      WHEN :'arg' = '' THEN o.status = 'AWAITING_PAYMENT'
      WHEN length(:'arg') = 36 AND :'arg' ~ '^[0-9a-f-]{36}$' THEN p.order_id::text = :'arg'
      ELSE p.qr_code = :'arg'
    END
  ORDER BY p.created_at DESC
  LIMIT 1
), pay AS (
  UPDATE payments SET status = 'APPROVED'
  WHERE id = (SELECT payment_id FROM target) AND (SELECT pay_status FROM target) = 'PENDING'
  RETURNING id
), ord AS (
  UPDATE orders SET status = 'PENDING'
  WHERE id = (SELECT order_id FROM target) AND (SELECT order_status FROM target) = 'AWAITING_PAYMENT'
  RETURNING id
), ev AS (
  INSERT INTO order_events (order_id, status, actor_role, note)
  SELECT id, 'PENDING', 'SYSTEM', 'pagamento confirmado (PIX simulado em dev)' FROM ord
  RETURNING order_id
)
SELECT
  CASE
    WHEN (SELECT count(*) FROM target) = 0 THEN '✗ PIX/pedido não encontrado (ou nada aguardando pagamento)'
    WHEN (SELECT count(*) FROM ord) = 0 THEN '✗ Pedido não está mais AWAITING_PAYMENT (já pago/expirado?)'
    ELSE '✓ PAGO! Pedido ' || (SELECT order_id::text FROM ev) || ' confirmado — acompanhe no tracking/painel da loja'
  END AS resultado;
EOF
)

echo "$SQL" | docker compose exec -T postgres psql -U postgres -d delivery -v arg="$ARG" -t -A
