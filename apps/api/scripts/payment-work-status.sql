\set ON_ERROR_STOP on

-- Sanitized operational counts only. Never add provider bodies, emails, QR data, or secrets.
select status, to_jsonb(w)->>('failure' || chr(95) || 'class') as failure, count(*) as items,
  extract(epoch from now() - min(created_at))::int as oldest_age_seconds
from payment_webhook_inbox w
group by status, to_jsonb(w)->>('failure' || chr(95) || 'class')
order by status, failure;

select status, to_jsonb(o)->>('failure' || chr(95) || 'class') as failure, count(*) as items,
  extract(epoch from now() - min(created_at))::int as oldest_age_seconds
from payment_operations o
group by status, to_jsonb(o)->>('failure' || chr(95) || 'class')
order by status, failure;

select reconciliation_state, reconciliation_failure as failure, count(*) as items,
  extract(epoch from now() - min(updated_at))::int as oldest_age_seconds
from payments
group by reconciliation_state, reconciliation_failure
order by reconciliation_state, reconciliation_failure;
