-- Application role. Apply after schema.sql, as the table owner.
-- pashadhara_app owns nothing, is not a superuser, cannot create temp tables, and cannot disable triggers or truncate.
-- It can insert, read, and update only the state columns below. Triggers in schema.sql enforce the transitions.
-- Connect as kernel_login, then SET ROLE pashadhara_app on every checked-out connection.
-- Deployment only: ALTER ROLE kernel_login PASSWORD using a securely bound value from env.
-- Never store the password in this file. RESET ROLE must return to kernel_login, never the owner.

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'pashadhara_app') then
    create role pashadhara_app nologin nosuperuser nocreatedb nocreaterole;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'kernel_login') then
    create role kernel_login login nosuperuser noinherit nocreatedb nocreaterole noreplication nobypassrls;
  end if;
end $$;
alter role kernel_login login nosuperuser noinherit nocreatedb nocreaterole noreplication nobypassrls;
grant pashadhara_app to kernel_login;
revoke all on schema public from public;
revoke all on schema public from kernel_login;

revoke all on all tables in schema public from public;
revoke all on all functions in schema public from public;
grant usage on schema public to pashadhara_app;

-- No temp tables for the application role (a temp table was the search_path shadow attack in review 002).
do $$ begin
  execute format('revoke temporary on database %I from public', current_database());
  execute format('revoke temporary on database %I from pashadhara_app', current_database());
end $$;

grant select on all tables in schema public to pashadhara_app;
grant insert on sellers, tools, leases, authorizations, paypal_calls, jobs, verdicts, decisions, captures,
                ledger_entries, tool_calls, payouts, webhook_events, capture_allocations to pashadhara_app;
grant usage on all sequences in schema public to pashadhara_app;
-- The kernel calls these directly or through triggers. All of them pin search_path and qualify every name.
grant execute on all functions in schema public to pashadhara_app;

grant update (state, paypal_order_id, closed_at) on leases to pashadhara_app;
grant update (status) on authorizations to pashadhara_app;
grant update (state, http_status, response, sent_at, resolved_at) on paypal_calls to pashadhara_app;
grant update (status, fee_minor, paypal_capture_id, settled_at) on captures to pashadhara_app;
grant update (state, deliverable_hash) on jobs to pashadhara_app;
grant update (state, call_id, paypal_batch_id, held_at) on payouts to pashadhara_app;
grant update (deliveries, processed_at) on webhook_events to pashadhara_app;
grant update (active, name, description) on tools to pashadhara_app;
grant update (payout_hold_seconds) on sellers to pashadhara_app;
-- No DELETE and no TRUNCATE on any table. kernel_settings, posting_shapes and judge_providers are read-only to the app.
-- A tool price change is a new tool row. paypal_calls response and http_status are frozen once set by a trigger.
