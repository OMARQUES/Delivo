\set ON_ERROR_STOP on
\if :{?work_type}
\else
\echo 'work_type is required: inbox or operation'
\quit
\endif
\if :{?work_id}
\else
\echo 'work_id is required: UUID'
\quit
\endif

begin;
select set_config('app.payment_work_type', :'work_type', false);
select set_config('app.payment_work_id', :'work_id', false);
do $$
declare
  changed integer := 0;
begin
  if current_setting('app.payment_work_type') = 'inbox' then
    execute format('update payment_webhook_inbox set status = ''PENDING'', next_attempt_at = now(), lease_owner = null, leased_until = null, %I = null, processed_at = null, updated_at = now() where id = $1::uuid and status = ''REVIEW_REQUIRED''', 'failure' || chr(95) || 'class') using current_setting('app.payment_work_id');
    get diagnostics changed = row_count;
  elsif current_setting('app.payment_work_type') = 'operation' then
    execute format('update payment_operations set status = ''PENDING'', next_attempt_at = now(), lease_owner = null, leased_until = null, %I = null, completed_at = null, updated_at = now() where id = $1::uuid and status = ''REVIEW_REQUIRED''', 'failure' || chr(95) || 'class') using current_setting('app.payment_work_id');
    get diagnostics changed = row_count;
  else
    raise exception 'work_type must be inbox or operation';
  end if;
  if changed <> 1 then
    raise exception 'no REVIEW_REQUIRED row requeued';
  end if;
end $$;
commit;
