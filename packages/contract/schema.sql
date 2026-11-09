-- PASHADHARA kernel schema v0.5. Postgres 15+. Money is bigint minor units (USD cents). No floats.
-- Enforces invariants in the database wherever a constraint can express them. See INVARIANTS.md.
-- Deployment: apply roles.sql after this file. Connect as kernel_login, SET ROLE pashadhara_app; neither owns tables.
-- Isolation: run at READ COMMITTED. Every write path takes the lease lock first through public.lock_lease(), which
-- also makes REPEATABLE READ fail closed with 40001 instead of committing past a cap.
-- Every function pins its search_path and schema-qualifies every table and function, so a temp table cannot shadow them.

create type lease_state as enum ('pending_approval', 'active', 'closed', 'expired', 'failed');
create type ledger_account as enum (
  'BUYER_COMMITMENT', 'HOLD_AVAILABLE', 'COMMITTED_UNSETTLED', 'CAPTURED_GROSS', 'PAYPAL_FEES',
  'SELLER_COST', 'SELLER_PAYABLE', 'RELEASED', 'WRITTEN_OFF', 'CHARGEBACK_LOSS'
);

create table kernel_settings (key text primary key, value text not null);
-- Owner-only knobs. created_at_slack: how far an authorization's created_at may differ from the clock.
-- max_reauth_depth: 1 means only the root may be reauthorized, once. Raise it only after a logged day-4 test shows a second reauthorization works.
insert into kernel_settings (key, value) values ('created_at_slack', '1 minute'), ('max_reauth_depth', '1');
create function setting(k text) returns text language sql stable set search_path = pg_catalog, pg_temp as
  $$ select value from public.kernel_settings where key = k $$;

create table judge_providers (id text primary key check (id = lower(id) and length(id) > 0));
insert into judge_providers (id) values ('openai'), ('anthropic'), ('xai'), ('google');

create table sellers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  paypal_email text not null,
  payout_hold_seconds integer not null default 60 check (payout_hold_seconds >= 30),
  created_at timestamptz not null default now()
);

create table tools (
  id text primary key,
  seller_id uuid not null references sellers(id),
  name text not null,
  description text not null default '',
  price_minor bigint not null check (price_minor > 0),
  active boolean not null default true
);

create table leases (
  id uuid primary key default gen_random_uuid(),
  buyer_ref text not null,
  currency char(3) not null default 'USD' check (currency = 'USD'),
  cap_minor bigint not null check (cap_minor > 0),
  unsettled_limit_minor bigint not null check (unsettled_limit_minor >= 0),
  state lease_state not null default 'pending_approval',
  paypal_order_id text unique,
  created_at timestamptz not null default now(),
  closed_at timestamptz,
  check (unsettled_limit_minor <= cap_minor)
);

create function lock_lease(p_lease uuid) returns public.lease_state language plpgsql set search_path = pg_catalog, pg_temp as $$
declare st public.lease_state;
begin
  update public.leases set state = state where id = p_lease returning state into st;
  if st is null then
    raise exception 'Unknown lease %', p_lease using errcode = 'foreign_key_violation';
  end if;
  return st;
end $$;

create table authorizations (
  id uuid primary key default gen_random_uuid(),
  lease_id uuid not null references leases(id),
  parent_id uuid,
  paypal_authorization_id text not null unique,
  amount_minor bigint not null check (amount_minor > 0),
  status text not null check (status in ('created', 'partially_captured', 'captured', 'voided', 'expired', 'denied', 'superseded')),
  created_at timestamptz not null default now(),
  honor_until timestamptz not null,
  expires_at timestamptz not null,
  unique (lease_id, id),
  foreign key (lease_id, parent_id) references authorizations (lease_id, id)
);
create unique index one_live_authorization on authorizations (lease_id) where status in ('created', 'partially_captured');
create unique index one_child_per_parent on authorizations (parent_id) where parent_id is not null;
create unique index one_root_per_lease on authorizations (lease_id) where parent_id is null;

create table paypal_calls (
  id uuid primary key default gen_random_uuid(),
  lease_id uuid not null references leases(id),
  op text not null check (op in ('create_order', 'authorize', 'capture', 'reauthorize', 'void', 'payout', 'get')),
  request_id uuid not null unique,
  amount_minor bigint check (amount_minor is null or amount_minor > 0),
  state text not null check (state in ('intent', 'sent', 'succeeded', 'failed', 'unknown')),
  http_status integer,
  response jsonb,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  resolved_at timestamptz,
  check (state not in ('sent', 'unknown', 'succeeded') or sent_at is not null)
);
create unique index one_money_call_in_flight on paypal_calls (lease_id)
  where op in ('capture', 'reauthorize', 'void') and state in ('intent', 'sent', 'unknown');

create table jobs (
  id uuid primary key default gen_random_uuid(),
  lease_id uuid not null references leases(id),
  seller_id uuid not null references sellers(id),
  amount_minor bigint not null check (amount_minor > 0),
  rubric jsonb not null,
  acceptance jsonb not null default '{}'::jsonb,
  state text not null default 'open' check (state in ('open', 'delivered', 'judging', 'decided', 'settled', 'voided', 'held')),
  deliverable_hash text,
  created_at timestamptz not null default now(),
  unique (lease_id, id)
);

create table verdicts (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references jobs(id),
  round integer not null default 1 check (round between 1 and 3),
  judge_provider text not null references judge_providers(id),
  model text not null,
  verdict text not null check (verdict in ('pass', 'fail', 'unsure')),
  score integer not null check (score between 0 and 100),
  reasons jsonb not null default '[]'::jsonb,
  prechecks jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (job_id, judge_provider, round)
);

create table decisions (
  id uuid primary key default gen_random_uuid(),
  lease_id uuid not null,
  job_id uuid not null,
  round integer not null default 0 check (round between 0 and 3),
  outcome text not null check (outcome in ('release', 'partial', 'void', 'hold')),
  amount_minor bigint not null check (amount_minor >= 0),
  derived_from jsonb not null,
  created_at timestamptz not null default now(),
  unique (lease_id, id),
  foreign key (lease_id, job_id) references jobs (lease_id, id),
  check ((outcome in ('void', 'hold') and amount_minor = 0) or (outcome in ('release', 'partial') and amount_minor > 0))
);
create unique index one_final_decision_per_job on decisions (job_id) where outcome <> 'hold';

create table captures (
  id uuid primary key default gen_random_uuid(),
  lease_id uuid not null references leases(id),
  authorization_id uuid not null,
  call_id uuid not null unique references paypal_calls(id),
  decision_id uuid,
  paypal_capture_id text unique,
  amount_minor bigint not null check (amount_minor > 0),
  fee_minor bigint check (fee_minor is null or fee_minor >= 0),
  status text not null check (status in ('intent', 'pending', 'completed', 'declined', 'denied', 'reversed', 'unknown')),
  created_at timestamptz not null default now(),
  settled_at timestamptz,
  foreign key (lease_id, authorization_id) references authorizations (lease_id, id),
  foreign key (lease_id, decision_id) references decisions (lease_id, id),
  check (status not in ('completed', 'reversed') or (fee_minor is not null and paypal_capture_id is not null))
);
create unique index one_capture_in_flight on captures (lease_id) where status in ('intent', 'pending', 'unknown');

create table capture_allocations (
  capture_id uuid not null references captures(id),
  lease_id uuid not null references leases(id),
  ref_id text not null,
  amount_minor bigint not null check (amount_minor > 0),
  primary key (capture_id, ref_id)
);
create index allocations_by_ref on capture_allocations (lease_id, ref_id);

create table ledger_entries (
  id bigint generated always as identity primary key,
  group_id uuid not null,
  lease_id uuid not null references leases(id),
  seller_id uuid references sellers(id),
  account ledger_account not null,
  direction char(1) not null check (direction in ('D', 'C')),
  amount_minor bigint not null check (amount_minor > 0),
  ref_type text not null,
  ref_id text not null,
  created_at timestamptz not null default now(),
  check ((account in ('SELLER_COST', 'SELLER_PAYABLE')) = (seller_id is not null))
);
create index ledger_by_lease on ledger_entries (lease_id, account);
create index ledger_by_group on ledger_entries (group_id);
create unique index ledger_one_posting_per_ref on ledger_entries (ref_type, ref_id, account, direction) where ref_type <> 'clawback';
create unique index ledger_one_clawback_per_seller on ledger_entries (ref_id, seller_id, account, direction) where ref_type = 'clawback';

create table posting_shapes (
  ref_type text not null,
  account ledger_account not null,
  direction char(1) not null,
  primary key (ref_type, account, direction)
);
insert into posting_shapes (ref_type, account, direction) values
  ('authorize', 'HOLD_AVAILABLE', 'D'), ('authorize', 'BUYER_COMMITMENT', 'C'),
  ('commit', 'COMMITTED_UNSETTLED', 'D'), ('commit', 'HOLD_AVAILABLE', 'C'),
  ('capture', 'CAPTURED_GROSS', 'D'), ('capture', 'COMMITTED_UNSETTLED', 'C'),
  ('capture', 'PAYPAL_FEES', 'D'), ('capture', 'CAPTURED_GROSS', 'C'),
  ('accrue', 'SELLER_COST', 'D'), ('accrue', 'SELLER_PAYABLE', 'C'),
  ('payout', 'SELLER_PAYABLE', 'D'), ('payout', 'CAPTURED_GROSS', 'C'),
  ('return', 'HOLD_AVAILABLE', 'D'), ('return', 'COMMITTED_UNSETTLED', 'C'),
  ('void', 'RELEASED', 'D'), ('void', 'HOLD_AVAILABLE', 'C'),
  ('writeoff', 'WRITTEN_OFF', 'D'), ('writeoff', 'COMMITTED_UNSETTLED', 'C'),
  ('reversal', 'CHARGEBACK_LOSS', 'D'), ('reversal', 'CAPTURED_GROSS', 'C'),
  ('clawback', 'SELLER_PAYABLE', 'D'), ('clawback', 'SELLER_COST', 'C');

create table tool_calls (
  id uuid primary key default gen_random_uuid(),
  lease_id uuid not null references leases(id),
  tool_id text not null references tools(id),
  idempotency_key text not null,
  price_minor bigint not null check (price_minor > 0),
  status text not null check (status in ('served', 'refused_cap', 'refused_exposure', 'refused_window', 'refused_inactive')),
  ledger_group_id uuid,
  created_at timestamptz not null default now(),
  unique (lease_id, idempotency_key),
  check (status <> 'served' or ledger_group_id is not null)
);

create table payouts (
  id uuid primary key default gen_random_uuid(),
  lease_id uuid not null references leases(id),
  seller_id uuid not null references sellers(id),
  source text not null check (source in ('job', 'metered')),
  decision_id uuid,
  amount_minor bigint not null check (amount_minor > 0),
  receiver_email text,
  state text not null check (state in ('queued', 'sent', 'success', 'failed', 'unknown')),
  release_at timestamptz not null,
  held_at timestamptz,
  call_id uuid unique references paypal_calls(id),
  paypal_batch_id text,
  created_at timestamptz not null default now(),
  foreign key (lease_id, decision_id) references decisions (lease_id, id),
  check ((source = 'job') = (decision_id is not null))
);
create unique index one_payout_per_decision on payouts (decision_id) where decision_id is not null and state <> 'failed';
create unique index one_payout_per_batch on payouts (paypal_batch_id) where paypal_batch_id is not null;

create table webhook_events (
  id text not null,
  event_type text not null,
  resource jsonb not null,
  signature_verified boolean not null,
  source text not null default 'webhook' check (source in ('webhook', 'poll')),
  deliveries integer not null default 1,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  primary key (id, signature_verified),
  check (processed_at is null or signature_verified)
);

----------------------------------------------------------------------------------------------------
-- Generic guards
----------------------------------------------------------------------------------------------------

create function forbid_column_change() returns trigger language plpgsql set search_path = pg_catalog, pg_temp as $$
declare col text; o jsonb := to_jsonb(old); n jsonb := to_jsonb(new);
begin
  foreach col in array tg_argv loop
    if o -> col is distinct from n -> col then
      raise exception 'Immutable column %.% changed', tg_table_name, col using errcode = 'check_violation';
    end if;
  end loop;
  return new;
end $$;

create function freeze_once_set() returns trigger language plpgsql set search_path = pg_catalog, pg_temp as $$
declare col text; o jsonb := to_jsonb(old); n jsonb := to_jsonb(new);
begin
  foreach col in array tg_argv loop
    if jsonb_typeof(o -> col) <> 'null' and o -> col is distinct from n -> col then
      raise exception 'Column %.% is frozen once set', tg_table_name, col using errcode = 'check_violation';
    end if;
  end loop;
  return new;
end $$;

create function forbid_all_changes() returns trigger language plpgsql set search_path = pg_catalog, pg_temp as $$
begin
  raise exception 'I3 violated: % is append-only', tg_table_name using errcode = 'check_violation';
end $$;

create function lock_lease_trigger() returns trigger language plpgsql set search_path = pg_catalog, pg_temp as $$
begin
  perform public.lock_lease(new.lease_id);
  return new;
end $$;
create trigger aa_lock_lease before insert on paypal_calls for each row execute function lock_lease_trigger();
create trigger aa_lock_lease before insert on jobs for each row execute function lock_lease_trigger();
create trigger aa_lock_lease before insert on decisions for each row execute function lock_lease_trigger();
create trigger aa_lock_lease before insert on tool_calls for each row execute function lock_lease_trigger();
create trigger aa_lock_lease before insert on payouts for each row execute function lock_lease_trigger();

create trigger leases_immutable before update on leases for each row execute function forbid_column_change('cap_minor', 'currency', 'buyer_ref', 'created_at');
create trigger leases_freeze before update on leases for each row execute function freeze_once_set('paypal_order_id');
create trigger authorizations_immutable before update on authorizations for each row
  execute function forbid_column_change('lease_id', 'parent_id', 'amount_minor', 'paypal_authorization_id', 'created_at', 'honor_until', 'expires_at');
create trigger captures_immutable before update on captures for each row
  execute function forbid_column_change('lease_id', 'authorization_id', 'decision_id', 'amount_minor', 'call_id', 'created_at');
create trigger captures_freeze before update on captures for each row execute function freeze_once_set('fee_minor', 'paypal_capture_id');
create trigger paypal_calls_immutable before update on paypal_calls for each row
  execute function forbid_column_change('lease_id', 'op', 'request_id', 'amount_minor', 'created_at');
create trigger paypal_calls_freeze before update on paypal_calls for each row execute function freeze_once_set('response', 'http_status', 'sent_at');
create trigger jobs_immutable before update on jobs for each row
  execute function forbid_column_change('lease_id', 'seller_id', 'amount_minor', 'rubric', 'acceptance', 'created_at');
create trigger payouts_immutable before update on payouts for each row
  execute function forbid_column_change('lease_id', 'seller_id', 'source', 'decision_id', 'amount_minor', 'receiver_email', 'release_at', 'created_at');
create trigger payouts_freeze before update on payouts for each row execute function freeze_once_set('paypal_batch_id', 'call_id');
create trigger webhook_events_immutable before update on webhook_events for each row
  execute function forbid_column_change('id', 'event_type', 'resource', 'signature_verified', 'source', 'received_at');
create trigger webhook_events_freeze before update on webhook_events for each row execute function freeze_once_set('processed_at');
create trigger tools_immutable before update on tools for each row execute function forbid_column_change('id', 'seller_id', 'price_minor');
create trigger ledger_no_update before update or delete on ledger_entries for each row execute function forbid_all_changes();
create trigger ledger_no_truncate before truncate on ledger_entries for each statement execute function forbid_all_changes();
create trigger decisions_no_update before update or delete on decisions for each row execute function forbid_all_changes();
create trigger verdicts_no_update before update or delete on verdicts for each row execute function forbid_all_changes();

create function sellers_guard() returns trigger language plpgsql set search_path = pg_catalog, pg_temp as $$
begin
  if new.paypal_email is distinct from old.paypal_email or new.id is distinct from old.id then
    raise exception 'Seller identity and payout address are immutable. Create a new seller.' using errcode = 'check_violation';
  end if;
  if new.payout_hold_seconds < old.payout_hold_seconds then
    raise exception 'Payout hold can only increase' using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger sellers_guard before update on sellers for each row execute function sellers_guard();

create function webhook_events_guard() returns trigger language plpgsql set search_path = pg_catalog, pg_temp as $$
begin
  if new.deliveries <> old.deliveries and new.deliveries <> old.deliveries + 1 then
    raise exception 'deliveries can only increase by one per repeat delivery' using errcode = 'check_violation';
  end if;
  if new.processed_at is not null and old.processed_at is null and not old.signature_verified then
    raise exception 'I12 violated: unverified event cannot be processed' using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger webhook_events_guard before update on webhook_events for each row execute function webhook_events_guard();

----------------------------------------------------------------------------------------------------
-- State machines (terminal states stay terminal) tied to PayPal evidence
----------------------------------------------------------------------------------------------------

create function authorization_status_guard() returns trigger language plpgsql set search_path = pg_catalog, pg_temp as $$
begin
  perform public.lock_lease(new.lease_id);
  if new.status = old.status then return new; end if;
  if not ((old.status = 'created' and new.status in ('partially_captured', 'captured', 'voided', 'expired', 'denied', 'superseded'))
       or (old.status = 'partially_captured' and new.status in ('captured', 'voided', 'expired', 'superseded'))) then
    raise exception 'Authorization status % to % is not allowed', old.status, new.status using errcode = 'check_violation';
  end if;
  if new.status = 'expired' and now() < old.expires_at and not exists (
    select 1 from public.paypal_calls where lease_id = old.lease_id and op = 'get' and state = 'succeeded'
      and response ->> 'id' = old.paypal_authorization_id and response ->> 'status' = 'EXPIRED') then
    raise exception 'I8 violated: expiry needs the clock or a matching PayPal GET response' using errcode = 'check_violation';
  end if;
  if new.status = 'denied' and not exists (
    select 1 from public.paypal_calls where lease_id = old.lease_id and state = 'succeeded'
      and op in ('get', 'authorize') and response ->> 'id' = old.paypal_authorization_id and response ->> 'status' = 'DENIED') then
    raise exception 'I8 violated: denied needs matching PayPal evidence' using errcode = 'check_violation';
  end if;
  if new.status = 'captured' and old.amount_minor <> (
    select coalesce(sum(amount_minor),0) from public.captures where authorization_id = old.id and status in ('completed','reversed')) then
    raise exception 'I8 violated: captured authorization needs completed captures equal to its amount' using errcode = 'check_violation';
  end if;
  if new.status = 'voided' and not exists (select 1 from public.paypal_calls where lease_id = old.lease_id and op = 'void' and state = 'succeeded') then
    raise exception 'I17 violated: an authorization is voided only after a succeeded void call' using errcode = 'check_violation';
  end if;
  if new.status = 'superseded' and not exists (select 1 from public.paypal_calls where lease_id = old.lease_id and op = 'reauthorize' and state = 'succeeded') then
    raise exception 'I17 violated: an authorization is superseded only after a succeeded reauthorize call' using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger authorizations_status before update of status on authorizations for each row execute function authorization_status_guard();

create function paypal_call_state_guard() returns trigger language plpgsql set search_path = pg_catalog, pg_temp as $$
begin
  if new.state = old.state then return new; end if;
  if not ((old.state = 'intent' and new.state in ('sent', 'failed'))
       or (old.state = 'sent' and new.state in ('succeeded', 'failed', 'unknown'))
       or (old.state = 'unknown' and new.state in ('succeeded', 'failed'))) then
    raise exception 'PayPal call state % to % is not allowed', old.state, new.state using errcode = 'check_violation';
  end if;
  if old.state = 'intent' and new.state = 'failed' and new.sent_at is not null then
    raise exception 'A call that was sent cannot fail without a response. Mark it unknown and read PayPal (I7).' using errcode = 'check_violation';
  end if;
  if old.state in ('sent', 'unknown') and new.state in ('succeeded', 'failed') and new.response is null then
    raise exception 'I7 violated: resolving a sent call needs the PayPal response or a read of PayPal state' using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger paypal_calls_state before update of state on paypal_calls for each row execute function paypal_call_state_guard();

-- A capture becomes completed only when its call succeeded and the PayPal response shows the same id, amount and fee.
create function capture_status_guard() returns trigger language plpgsql set search_path = pg_catalog, pg_temp as $$
declare c public.paypal_calls%rowtype; resp_fee bigint; resp_amt bigint;
begin
  perform public.lock_lease(new.lease_id);
  if new.status = old.status then return new; end if;
  if not ((old.status = 'intent' and new.status in ('pending', 'completed', 'declined', 'denied', 'unknown'))
       or (old.status = 'pending' and new.status in ('completed', 'declined', 'denied', 'unknown'))
       or (old.status = 'unknown' and new.status in ('completed', 'declined', 'denied'))
       or (old.status = 'completed' and new.status = 'reversed')) then
    raise exception 'Capture status % to % is not allowed. declined, denied and reversed are terminal.', old.status, new.status using errcode = 'check_violation';
  end if;
  if new.status in ('declined','denied') then
    select * into c from public.paypal_calls where id = new.call_id;
    if c.response is null or not (c.state = 'failed' or
      (c.state = 'succeeded' and upper(c.response ->> 'status') in ('DECLINED','DENIED'))) then
      raise exception 'I17 violated: decline needs the capture call failed with response or a succeeded decline response' using errcode = 'check_violation';
    end if;
  end if;
  if new.status = 'completed' then
    select * into c from public.paypal_calls where id = new.call_id;
    if c.state <> 'succeeded' or c.response is null then
      raise exception 'I17 violated: capture completes only after its PayPal call succeeded with a stored response' using errcode = 'check_violation';
    end if;
    resp_fee := public.paypal_minor(c.response #>> '{seller_receivable_breakdown,paypal_fee,value}');
    resp_amt := public.paypal_minor(c.response #>> '{amount,value}');
    if resp_fee is distinct from new.fee_minor or resp_amt is distinct from new.amount_minor
       or (c.response ->> 'id') is distinct from new.paypal_capture_id then
      raise exception 'I17 violated: capture id, amount and fee must equal the stored PayPal response (id %, amount %, fee %)', c.response ->> 'id', resp_amt, resp_fee using errcode = 'check_violation';
    end if;
  end if;
  return new;
end $$;
create trigger captures_status before update of status on captures for each row execute function capture_status_guard();

create function job_state_guard() returns trigger language plpgsql set search_path = pg_catalog, pg_temp as $$
begin
  if new.state = old.state then return new; end if;
  if not ((old.state = 'open' and new.state in ('delivered', 'voided'))
       or (old.state = 'delivered' and new.state in ('judging', 'voided'))
       or (old.state = 'judging' and new.state in ('decided', 'held', 'voided'))
       or (old.state = 'held' and new.state in ('judging', 'decided', 'voided'))
       or (old.state = 'decided' and new.state in ('settled', 'held'))) then
    raise exception 'Job state % to % is not allowed', old.state, new.state using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger jobs_state before update of state on jobs for each row execute function job_state_guard();

-- An appeal (job held) freezes any unsent payout for that job.
create function job_held_freezes_payouts() returns trigger language plpgsql set search_path = pg_catalog, pg_temp as $$
begin
  if new.state = 'held' and old.state <> 'held' then
    update public.payouts set held_at = now()
      where state = 'queued' and held_at is null and decision_id in (select id from public.decisions where job_id = new.id);
  elsif new.state = 'decided' and old.state = 'held' then
    update public.payouts set held_at = null
      where state = 'queued' and decision_id in (select id from public.decisions where job_id = new.id);
  end if;
  return null;
end $$;
create trigger jobs_held after update of state on jobs for each row execute function job_held_freezes_payouts();

-- A payout leaves queued only through its own PayPal payout call, never while held, due, or while the lease has a reversed capture.
create function payout_state_guard() returns trigger language plpgsql set search_path = pg_catalog, pg_temp as $$
declare c public.paypal_calls%rowtype; job_state text; resp_batch text;
begin
  perform public.lock_lease(new.lease_id);
  if new.held_at is distinct from old.held_at and pg_trigger_depth() <= 1 then
    raise exception 'Column payouts.held_at is frozen outside the jobs trigger' using errcode = 'check_violation';
  end if;
  if new.paypal_batch_id is distinct from old.paypal_batch_id and new.state <> 'success' then
    raise exception 'I13 violated: a PayPal batch id is recorded only when the payout succeeds' using errcode = 'check_violation';
  end if;
  if new.state = old.state then return new; end if;
  if not ((old.state = 'queued' and new.state in ('sent', 'failed'))
       or (old.state = 'sent' and new.state in ('success', 'failed', 'unknown'))
       or (old.state = 'unknown' and new.state in ('success', 'failed'))) then
    raise exception 'Payout state % to % is not allowed', old.state, new.state using errcode = 'check_violation';
  end if;
  if new.call_id is not null then
    select * into c from public.paypal_calls where id = new.call_id;
    if c.op is distinct from 'payout' or c.lease_id <> new.lease_id then
      raise exception 'I13 violated: payout call must be a payout call on the same lease' using errcode = 'check_violation';
    end if;
  end if;
  if old.state = 'queued' and new.state = 'failed' and ((new.call_id is not null and c.state not in ('intent', 'failed')) or new.paypal_batch_id is not null) then
    raise exception 'I13 violated: a payout with a PayPal call is not cancelled, resolve it from the call' using errcode = 'check_violation';
  end if;
  if new.state = 'sent' then
    if new.call_id is null or c.state not in ('sent', 'succeeded') or c.amount_minor is distinct from new.amount_minor then
      raise exception 'I13 violated: payout is sent only with its PayPal payout call' using errcode = 'check_violation';
    end if;
    if new.held_at is not null or new.release_at > now() then
      raise exception 'I13 violated: payout is held or its release time has not arrived' using errcode = 'check_violation';
    end if;
    if public.uncovered_clawbacks(new.lease_id) then
      raise exception 'I13 violated: payouts are frozen while the lease has a reversed capture' using errcode = 'check_violation';
    end if;
    perform public.check_payout_funding(new.lease_id,new.seller_id,new.source,new.decision_id,new.amount_minor,new.id);
    if new.amount_minor > (
      select coalesce(sum(case direction when 'D' then amount_minor else -amount_minor end),0)
      from public.ledger_entries where lease_id=new.lease_id and account='CAPTURED_GROSS') - (
      select coalesce(sum(amount_minor),0) from public.payouts where lease_id=new.lease_id and id<>new.id and state in ('sent','unknown')) then
      raise exception 'I13 violated: payout exceeds available captured cash' using errcode='check_violation';
    end if;
    if new.decision_id is not null then
      select j.state into job_state from public.decisions d join public.jobs j on j.id = d.job_id where d.id = new.decision_id;
      if job_state = 'held' then
        raise exception 'I13 violated: the job is held (appeal), payout cannot be sent' using errcode = 'check_violation';
      end if;
    end if;
  end if;
  if new.state = 'success' then
    resp_batch := c.response #>> '{batch_header,payout_batch_id}';
    if new.paypal_batch_id is null or c.state <> 'succeeded' or resp_batch is distinct from new.paypal_batch_id
       or c.amount_minor is distinct from new.amount_minor
       or public.paypal_minor(c.response #>> '{batch_header,amount,value}') is distinct from new.amount_minor
       or c.response #>> '{batch_header,batch_status}' is distinct from 'SUCCESS' then
      raise exception 'I13 violated: payout succeeds only with a succeeded call whose response shows the same batch id' using errcode = 'check_violation';
    end if;
  end if;
  if new.state = 'failed' and old.state in ('sent', 'unknown') then
    if c.state <> 'failed' or c.response is null then
      raise exception 'I13 violated: a sent payout fails only with a failed call and a stored response' using errcode = 'check_violation';
    end if;
  end if;
  if new.state = 'unknown' and c.state <> 'unknown' then
    raise exception 'I13 violated: payout is unknown only when its call is unknown' using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger payouts_state before update on payouts for each row execute function payout_state_guard();

----------------------------------------------------------------------------------------------------
-- Insert-time rules
----------------------------------------------------------------------------------------------------

-- I1, I5, I6, I9: a capture starts as intent, has its own capture call row, and stays inside cap, authorization and decision.
-- Counted statuses include reversed because PayPal does not restore the authorization remainder after a reversal.
create function enforce_capture_insert() returns trigger language plpgsql set search_path = pg_catalog, pg_temp as $$
declare lease_cap bigint; lease_st public.lease_state; used bigint; auth_amt bigint; auth_used bigint; auth_status text;
        dec_amt bigint; dec_used bigint; call_op text; call_state text; call_lease uuid;
begin
  lease_st := public.lock_lease(new.lease_id);
  if new.status <> 'intent' then
    raise exception 'A capture must be inserted as intent' using errcode = 'check_violation';
  end if;
  if lease_st <> 'active' then
    raise exception 'Capture refused: lease is %', lease_st using errcode = 'check_violation';
  end if;
  select op, state, lease_id into call_op, call_state, call_lease from public.paypal_calls where id = new.call_id;
  if call_op is distinct from 'capture' or call_lease <> new.lease_id or call_state not in ('intent', 'sent', 'unknown') then
    raise exception 'I6 violated: capture needs its own open capture call row' using errcode = 'check_violation';
  end if;
  select cap_minor into lease_cap from public.leases where id = new.lease_id;
  select status, amount_minor into auth_status, auth_amt from public.authorizations where id = new.authorization_id;
  if auth_status not in ('created', 'partially_captured') then
    raise exception 'Capture refused: authorization is %', auth_status using errcode = 'check_violation';
  end if;
  select coalesce(sum(amount_minor), 0) into used from public.captures
    where lease_id = new.lease_id and status in ('intent', 'pending', 'completed', 'unknown', 'reversed');
  if used + new.amount_minor > lease_cap then
    raise exception 'I1 violated: captures % + % exceed lease cap %', used, new.amount_minor, lease_cap using errcode = 'check_violation';
  end if;
  select coalesce(sum(amount_minor), 0) into auth_used from public.captures
    where authorization_id = new.authorization_id and status in ('intent', 'pending', 'completed', 'unknown', 'reversed');
  if auth_used + new.amount_minor > auth_amt then
    raise exception 'I1 violated: captures % + % exceed authorization amount %', auth_used, new.amount_minor, auth_amt using errcode = 'check_violation';
  end if;
  if new.decision_id is not null then
    select amount_minor into dec_amt from public.decisions where id = new.decision_id;
    select coalesce(sum(amount_minor), 0) into dec_used from public.captures
      where decision_id = new.decision_id and status in ('intent', 'pending', 'completed', 'unknown', 'reversed');
    if dec_used + new.amount_minor > dec_amt then
      raise exception 'I9 violated: captures % + % exceed decision amount %', dec_used, new.amount_minor, dec_amt using errcode = 'check_violation';
    end if;
  end if;
  return new;
end $$;
create trigger captures_insert before insert on captures for each row execute function enforce_capture_insert();

-- I8: timestamps must agree with the clock. The root is fresh. A child comes at least 3 days after its parent, before expiry,
-- never in the future, and not deeper than max_reauth_depth. Amount is exactly cap minus counted captures.
create function enforce_authorization_insert() returns trigger language plpgsql set search_path = pg_catalog, pg_temp as $$
declare lease_cap bigint; used bigint; lease_st public.lease_state; p_created timestamptz; p_expires timestamptz;
        slack interval := public.setting('created_at_slack')::interval; max_depth integer := public.setting('max_reauth_depth')::integer; depth integer;
begin
  lease_st := public.lock_lease(new.lease_id);
  if lease_st not in ('pending_approval', 'active') then
    raise exception 'Authorization refused: lease is %', lease_st using errcode = 'check_violation';
  end if;
  if new.status <> 'created' then
    raise exception 'I8 violated: an authorization starts created; terminal status needs checked evidence' using errcode='check_violation';
  end if;
  if new.created_at > now() + interval '1 second' or new.created_at < now() - slack then
    raise exception 'I8 violated: created_at must be within % of the clock', slack using errcode = 'check_violation';
  end if;
  if new.honor_until <> new.created_at + interval '3 days' then
    raise exception 'I8 violated: honor_until must be created_at plus 3 days' using errcode = 'check_violation';
  end if;
  if new.expires_at <= new.honor_until or new.expires_at > new.created_at + interval '29 days' then
    raise exception 'I8 violated: expires_at must fall after the honor period and within 29 days of created_at' using errcode = 'check_violation';
  end if;
  select cap_minor into lease_cap from public.leases where id = new.lease_id;
  select coalesce(sum(amount_minor), 0) into used from public.captures
    where lease_id = new.lease_id and status in ('intent', 'pending', 'completed', 'unknown', 'reversed');
  if new.amount_minor <> lease_cap - used then
    raise exception 'I8 violated: authorization % must equal remaining cap %', new.amount_minor, lease_cap - used using errcode = 'check_violation';
  end if;
  if new.parent_id is not null then
    select created_at, expires_at into p_created, p_expires from public.authorizations where id = new.parent_id;
    if new.created_at < p_created + interval '3 days' or new.created_at > p_expires then
      raise exception 'I8 violated: reauthorization must fall after the 3-day honor period and before expiry (PayPal refused day 0 with REAUTHORIZATION_TOO_SOON)' using errcode = 'check_violation';
    end if;
    with recursive a as (
      select id, parent_id, 0 as d from public.authorizations where id = new.parent_id
      union all
      select x.id, x.parent_id, a.d + 1 from public.authorizations x join a on x.id = a.parent_id)
    select coalesce(max(d), 0) + 1 into depth from a;
    if depth > max_depth then
      raise exception 'I8 violated: reauthorization depth % exceeds max_reauth_depth % (PayPal said once, from day 4 to day 29)', depth, max_depth using errcode = 'check_violation';
    end if;
    if not exists (select 1 from public.paypal_calls where lease_id = new.lease_id and op = 'reauthorize' and state = 'succeeded') then
      raise exception 'I8 violated: child needs a succeeded reauthorize call on the parent lease' using errcode = 'check_violation';
    end if;

  end if;
  return new;
end $$;
create trigger authorizations_insert before insert on authorizations for each row execute function enforce_authorization_insert();

-- A rubric is non-empty, integers in range, distinct min_score, and pay_bps never decreases as the score rises.
create function validate_rubric(r jsonb) returns boolean language sql immutable set search_path = pg_catalog, pg_temp as $$
  select jsonb_typeof(r) = 'array' and jsonb_array_length(r) >= 1
    and not exists (
      select 1 from jsonb_array_elements(r) b
      where jsonb_typeof(b) <> 'object'
         or jsonb_typeof(b -> 'min_score') <> 'number' or jsonb_typeof(b -> 'pay_bps') <> 'number'
         or (b ->> 'min_score') !~ '^[0-9]+$' or (b ->> 'pay_bps') !~ '^[0-9]+$'
         or (b ->> 'min_score')::int > 100 or (b ->> 'pay_bps')::int > 10000)
    and not exists (
      select 1 from (
        select (b ->> 'min_score')::int as ms, (b ->> 'pay_bps')::int as pb,
               lag((b ->> 'min_score')::int) over (order by (b ->> 'min_score')::int) as pms,
               lag((b ->> 'pay_bps')::int) over (order by (b ->> 'min_score')::int) as ppb
        from jsonb_array_elements(r) b) o
      where o.pms = o.ms or o.pb < o.ppb)
$$;
create function enforce_job_insert() returns trigger language plpgsql set search_path = pg_catalog, pg_temp as $$
begin
  if exists(select 1 from public.tool_calls where lease_id=new.lease_id and id=new.id) then
    raise exception 'I17 violated: a job and tool call cannot share a monetary ref' using errcode='check_violation';
  end if;
  if not public.validate_rubric(new.rubric) then
    raise exception 'Rubric must be a non-empty array of {min_score 0-100, pay_bps 0-10000}, distinct scores, pay never decreasing as score rises' using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger jobs_insert before insert on jobs for each row execute function enforce_job_insert();

create function jobs_hash_guard() returns trigger language plpgsql set search_path = pg_catalog, pg_temp as $$
begin
  if new.deliverable_hash is distinct from old.deliverable_hash and exists (select 1 from public.verdicts where job_id = old.id) then
    raise exception 'deliverable_hash is frozen once a verdict exists' using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger jobs_hash before update of deliverable_hash on jobs for each row execute function jobs_hash_guard();

-- Verdicts come in rounds. A new round starts only after a hold, so a disagreement can be re-judged and cannot get stuck.
create function enforce_verdict_insert() returns trigger language plpgsql set search_path = pg_catalog, pg_temp as $$
declare maxr integer; n integer; passes integer; fails integer; l uuid;
begin
  select lease_id into l from public.jobs where id = new.job_id;
  perform public.lock_lease(l);
  perform 1 from public.jobs where id = new.job_id for update;
  if exists (select 1 from public.decisions where job_id = new.job_id and outcome <> 'hold') then
    raise exception 'Verdict refused: job already decided' using errcode = 'check_violation';
  end if;
  select coalesce(max(round), 0) into maxr from public.verdicts where job_id = new.job_id;
  select count(*), count(*) filter (where verdict = 'pass'),count(*) filter (where verdict='fail') into n, passes, fails
    from public.verdicts where job_id = new.job_id and round = maxr;
  if n >= 2 and passes = n then
    raise exception 'Verdict round refused: unanimous passes freeze further verdicts' using errcode = 'check_violation';
  end if;
  if not ((maxr = 0 and new.round = 1) or (new.round = maxr and n < 2)
      or (new.round = maxr + 1 and n = 2 and passes < 2 and fails < 2 and exists (
        select 1 from public.decisions where job_id = new.job_id and round = maxr and outcome = 'hold'))) then
    raise exception 'Verdict round % refused: current round % must be complete with a hold and not unanimous pass', new.round, maxr using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger verdicts_enforce before insert on verdicts for each row execute function enforce_verdict_insert();

-- I10, I11: the database derives the amount from the buyer's rubric and the latest round of verdicts.
-- Two passes from distinct providers and nothing else: pay the derived amount (void if zero).
-- Two fails from distinct providers and nothing else: void. A failed pre-check with no verdicts at all: void.
-- Anything else: hold, never void.
create function enforce_decision() returns trigger language plpgsql set search_path = pg_catalog, pg_temp as $$
declare j public.jobs%rowtype; r integer; total integer; passes integer; fails integer; unsure integer; minscore integer; bps integer; computed bigint;
begin
  perform public.lock_lease(new.lease_id);
  if exists(select 1 from public.tool_calls where lease_id=new.lease_id and id=new.id) then
    raise exception 'I17 violated: a decision and tool call cannot share an accrual ref' using errcode='check_violation';
  end if;
  select * into j from public.jobs where id = new.job_id for update;
  select count(*) into total from public.verdicts where job_id = new.job_id;
  select coalesce(max(round), 0) into r from public.verdicts where job_id = new.job_id;
  new.round := r;
  select count(distinct judge_provider) filter (where verdict = 'pass'),
         count(distinct judge_provider) filter (where verdict = 'fail'),
         count(*) filter (where verdict = 'unsure'),
         coalesce(min(score) filter (where verdict = 'pass'), 0)
    into passes, fails, unsure, minscore from public.verdicts where job_id = new.job_id and round = r;
  select coalesce((select (b ->> 'pay_bps')::int from jsonb_array_elements(j.rubric) b
                   where (b ->> 'min_score')::int <= minscore order by (b ->> 'min_score')::int desc limit 1), 0) into bps;
  computed := (j.amount_minor * bps) / 10000;

  if new.outcome = 'void' and (new.derived_from -> 'precheck_failed') = 'true'::jsonb and total = 0 then
    return new;
  elsif passes >= 2 and fails = 0 and unsure = 0 then
    if computed > 0 then
      if new.outcome not in ('release', 'partial') or new.amount_minor <> computed
         or (new.outcome = 'release') <> (computed = j.amount_minor) then
        raise exception 'I10 violated: decision % % must be % derived from rubric (min_score %, pay_bps %)', new.outcome, new.amount_minor, computed, minscore, bps using errcode = 'check_violation';
      end if;
      if (new.derived_from ->> 'min_score') is distinct from minscore::text or (new.derived_from ->> 'pay_bps') is distinct from bps::text then
        raise exception 'I10 violated: derived_from must record min_score % and pay_bps %', minscore, bps using errcode = 'check_violation';
      end if;
    elsif new.outcome <> 'void' then
      raise exception 'I10 violated: rubric pays 0 for score %, outcome must be void', minscore using errcode = 'check_violation';
    end if;
  elsif fails >= 2 and passes = 0 and unsure = 0 then
    if new.outcome <> 'void' then
      raise exception 'I11 violated: two failing providers can only void' using errcode = 'check_violation';
    end if;
  else
    if new.outcome <> 'hold' then
      raise exception 'I11 violated: disagreement, unsure or missing judge must hold (passes %, fails %, unsure %)', passes, fails, unsure using errcode = 'check_violation';
    end if;
  end if;
  return new;
end $$;
create trigger decisions_enforce before insert on decisions for each row execute function enforce_decision();

-- I13: a payout needs seller accrual of its own source, a completed capture (job source), the job's own seller, and the hold window.
-- The receiver address is copied from the seller at insert and frozen.
create function enforce_payout_insert() returns trigger language plpgsql set search_path = pg_catalog, pg_temp as $$
declare hold_s integer; email text; accrued bigint; committed bigint; dec_amt bigint; job_seller uuid; dec_outcome text;
begin
  select payout_hold_seconds, paypal_email into hold_s, email from public.sellers where id = new.seller_id;
  if new.state <> 'queued' then
    raise exception 'I13 violated: a payout must be inserted as queued' using errcode='check_violation';
  end if;
  new.receiver_email := email;
  if new.release_at < now() + make_interval(secs => hold_s) then
    raise exception 'I13 violated: release_at earlier than the seller hold window' using errcode = 'check_violation';
  end if;
  if new.held_at is not null or new.call_id is not null or new.paypal_batch_id is not null then
    raise exception 'A new payout starts clean: not held, no call, no batch id' using errcode = 'check_violation';
  end if;
  if public.uncovered_clawbacks(new.lease_id) then
    raise exception 'I13 violated: payouts are frozen while the lease has a reversed capture with uncovered accrual' using errcode='check_violation';
  end if;
  perform public.check_payout_funding(new.lease_id,new.seller_id,new.source,new.decision_id,new.amount_minor,new.id);
  select coalesce(sum(le.amount_minor), 0) into accrued from public.ledger_entries le
    where le.lease_id = new.lease_id and le.seller_id = new.seller_id and le.account = 'SELLER_PAYABLE' and le.direction = 'C' and le.ref_type = 'accrue'
      and ((new.source = 'job' and exists (select 1 from public.decisions d where d.id::text = le.ref_id))
        or (new.source = 'metered' and exists (select 1 from public.tool_calls t where t.id::text = le.ref_id)));
  select coalesce(sum(amount_minor), 0) into committed from public.payouts
    where lease_id = new.lease_id and seller_id = new.seller_id and source = new.source and state <> 'failed';
  if committed + new.amount_minor > accrued then
    raise exception 'I13 violated: % payouts % + % exceed seller accrual %', new.source, committed, new.amount_minor, accrued using errcode = 'check_violation';
  end if;
  if new.source = 'job' then
    select d.amount_minor, d.outcome, j.seller_id into dec_amt, dec_outcome, job_seller
      from public.decisions d join public.jobs j on j.id = d.job_id where d.id = new.decision_id;
    if dec_outcome not in ('release', 'partial') or job_seller <> new.seller_id then
      raise exception 'I13 violated: job payout needs a paying decision for this seller' using errcode = 'check_violation';
    end if;
    if not exists (select 1 from public.capture_allocations a join public.captures c on c.id = a.capture_id join public.decisions d on d.job_id::text = a.ref_id where d.id = new.decision_id and c.status = 'completed') then
      raise exception 'I13 violated: payout without a completed capture' using errcode = 'check_violation';
    end if;
    if new.amount_minor > dec_amt then
      raise exception 'I13 violated: payout % exceeds decision %', new.amount_minor, dec_amt using errcode = 'check_violation';
    end if;
  end if;
  return new;
end $$;
create trigger payouts_insert before insert on payouts for each row execute function enforce_payout_insert();

create function enforce_tool_call_insert() returns trigger language plpgsql set search_path = pg_catalog, pg_temp as $$
declare p bigint; g bigint;
begin
  if exists(select 1 from public.jobs where lease_id=new.lease_id and id=new.id)
     or exists(select 1 from public.decisions where lease_id=new.lease_id and id=new.id) then
    raise exception 'I17 violated: tool calls cannot share job or decision monetary refs' using errcode='check_violation';
  end if;
  select price_minor into p from public.tools where id = new.tool_id;
  if p is distinct from new.price_minor then
    raise exception 'Tool call price % differs from tool price %', new.price_minor, p using errcode = 'check_violation';
  end if;
  if new.status = 'served' then
    select coalesce(sum(amount_minor), 0) into g from public.ledger_entries
      where group_id = new.ledger_group_id and lease_id = new.lease_id and ref_type = 'commit'
        and ref_id = new.id::text and account = 'COMMITTED_UNSETTLED' and direction = 'D';
    if g <> new.price_minor then
      raise exception 'A served tool call needs a commit posting of exactly its price, with its own id as ref_id (found %)', g using errcode = 'check_violation';
    end if;
  end if;
  return new;
end $$;
create trigger tool_calls_insert before insert on tool_calls for each row execute function enforce_tool_call_insert();

-- Ledger rows: allowed shape, lease state, and a real link to the capture, call, job, tool call or payout they describe.
create function enforce_posting_shape() returns trigger language plpgsql set search_path = pg_catalog, pg_temp as $$
declare st public.lease_state; c public.captures%rowtype; po public.payouts%rowtype; dc public.decisions%rowtype; job_seller uuid; tc public.tool_calls%rowtype; tool_seller uuid; jb public.jobs%rowtype;
begin
  st := public.lock_lease(new.lease_id);
  if not exists (select 1 from public.posting_shapes where ref_type = new.ref_type and account = new.account and direction = new.direction) then
    raise exception 'I2 violated: posting shape % % % is not allowed', new.ref_type, new.account, new.direction using errcode = 'check_violation';
  end if;
  if (st = 'pending_approval' and new.ref_type <> 'authorize')
     or (st = 'closed' and new.ref_type not in ('payout', 'reversal', 'clawback'))
     or (st in ('expired', 'failed') and new.ref_type not in ('void', 'return', 'writeoff', 'payout', 'reversal', 'accrue', 'clawback'))
     or (st = 'active' and new.ref_type = 'authorize') then
    raise exception 'Posting % refused while lease is %', new.ref_type, st using errcode = 'check_violation';
  end if;
  if new.ref_type = 'capture' then
    select * into c from public.captures where id::text = new.ref_id and lease_id = new.lease_id and status = 'completed';
    if c.id is null then
      raise exception 'I17 violated: capture posting % has no completed capture on this lease', new.ref_id using errcode = 'check_violation';
    end if;
    if (new.account = 'CAPTURED_GROSS' and new.direction = 'D' and new.amount_minor <> c.amount_minor)
       or (new.account = 'COMMITTED_UNSETTLED' and new.amount_minor <> c.amount_minor)
       or (new.account = 'PAYPAL_FEES' and new.amount_minor <> c.fee_minor)
       or (new.account = 'CAPTURED_GROSS' and new.direction = 'C' and new.amount_minor <> c.fee_minor) then
      raise exception 'I17 violated: capture posting amount does not match capture row (amount %, fee %)', c.amount_minor, c.fee_minor using errcode = 'check_violation';
    end if;
  elsif new.ref_type = 'reversal' then
    select * into c from public.captures where id::text = new.ref_id and lease_id = new.lease_id and status = 'reversed';
    if c.id is null or new.amount_minor <> c.amount_minor then
      raise exception 'I17 violated: reversal must equal a reversed capture on this lease' using errcode = 'check_violation';
    end if;
  elsif new.ref_type = 'payout' then
    select * into po from public.payouts where id::text = new.ref_id and lease_id = new.lease_id and state = 'success';
    if po.id is null or po.amount_minor <> new.amount_minor or (new.seller_id is not null and po.seller_id <> new.seller_id) then
      raise exception 'I13 violated: payout posting needs a successful payout row with the same amount and seller' using errcode = 'check_violation';
    end if;
  elsif new.ref_type = 'accrue' then
    perform public.validate_accrual(new.lease_id,new.ref_id,new.amount_minor);
    if exists (select 1 from public.capture_allocations a join public.captures cp on cp.id=a.capture_id
      where a.lease_id=new.lease_id and cp.status='reversed' and
        (a.ref_id=new.ref_id or a.ref_id in (select job_id::text from public.decisions where id::text=new.ref_id))) then
      raise exception 'I17 violated: cannot create accrual after its allocation was reversed' using errcode='check_violation';
    end if;
    -- Accrue only to the seller who did the work: a paying job decision (with a completed capture) or a served tool call.
    select * into dc from public.decisions where id::text = new.ref_id and lease_id = new.lease_id;
    if dc.id is not null then
      select seller_id into job_seller from public.jobs where id = dc.job_id;
      if dc.outcome not in ('release', 'partial') or job_seller is distinct from new.seller_id or new.amount_minor > dc.amount_minor
         or not exists (select 1 from public.capture_allocations a join public.captures cp on cp.id = a.capture_id where a.ref_id = dc.job_id::text and cp.status = 'completed') then
        raise exception 'I17 violated: accrual needs a paying decision for this seller, a completed capture, and an amount within the decision' using errcode = 'check_violation';
      end if;
    else
      select * into tc from public.tool_calls where id::text = new.ref_id and lease_id = new.lease_id and status = 'served';
      select seller_id into tool_seller from public.tools where id = tc.tool_id;
      if tc.id is null or tool_seller is distinct from new.seller_id or new.amount_minor > tc.price_minor then
        raise exception 'I17 violated: accrual must reference a served tool call or paying job decision of this seller, within its amount' using errcode = 'check_violation';
      end if;
    end if;
  elsif new.ref_type = 'return' then
    -- Only an unserved job reserve can go back to the budget. Served usage never returns.
    select * into jb from public.jobs where id::text = new.ref_id and lease_id = new.lease_id;
    if jb.id is null or new.amount_minor > jb.amount_minor
       or new.amount_minor > jb.amount_minor - coalesce((select amount_minor from public.decisions where job_id = jb.id and outcome in ('release','partial')),0) then
      raise exception 'I17 violated: return must reference an unpaid job reserve on this lease' using errcode = 'check_violation';
    end if;
  elsif new.ref_type = 'writeoff' then
    select * into c from public.captures where id::text = new.ref_id and lease_id = new.lease_id and status in ('declined', 'denied');
    if c.id is null or new.amount_minor > c.amount_minor then
      raise exception 'I17 violated: writeoff must reference a declined or denied capture on this lease' using errcode = 'check_violation';
    end if;
  elsif new.ref_type = 'void' then
    if not exists (select 1 from public.paypal_calls where lease_id = new.lease_id and op = 'void' and state = 'succeeded') then
      raise exception 'I17 violated: a void posting needs a succeeded PayPal void call' using errcode = 'check_violation';
    end if;
  end if;
  return new;
end $$;
create trigger ledger_shape before insert on ledger_entries for each row execute function enforce_posting_shape();

----------------------------------------------------------------------------------------------------
-- Commit-time checks, under the lease lock
----------------------------------------------------------------------------------------------------

-- I16 conservation, I13 accrual bound, I17 ledger equals captures and reversals, cap re-sum.
create function check_lease_consistency(p_lease uuid) returns void language plpgsql set search_path = pg_catalog, pg_temp as $$
declare lease_cap bigint; lease_st public.lease_state;
        buyer_c bigint; open_and_sinks bigint; capd bigint; fees bigint; seller_cost bigint; comm bigint; rev_post bigint;
        cap_moved bigint; cap_fee bigint; cap_inflight bigint; cap_rev bigint; cap_counted bigint;
begin
  select cap_minor, state into lease_cap, lease_st from public.leases where id = p_lease;
  select coalesce(sum(case when account = 'BUYER_COMMITMENT' then (case direction when 'C' then amount_minor else -amount_minor end) end), 0),
         coalesce(sum(case when account in ('HOLD_AVAILABLE', 'COMMITTED_UNSETTLED', 'RELEASED', 'WRITTEN_OFF')
                           then (case direction when 'D' then amount_minor else -amount_minor end) end), 0),
         coalesce(sum(amount_minor) filter (where ref_type = 'capture' and account = 'CAPTURED_GROSS' and direction = 'D'), 0),
         coalesce(sum(amount_minor) filter (where ref_type = 'capture' and account = 'PAYPAL_FEES' and direction = 'D'), 0),
         coalesce(sum(amount_minor) filter (where account = 'SELLER_COST' and direction = 'D'), 0),
         coalesce(sum(case when account = 'COMMITTED_UNSETTLED' then (case direction when 'D' then amount_minor else -amount_minor end) end), 0),
         coalesce(sum(amount_minor) filter (where ref_type = 'reversal' and account = 'CHARGEBACK_LOSS' and direction = 'D'), 0)
    into buyer_c, open_and_sinks, capd, fees, seller_cost, comm, rev_post
    from public.ledger_entries where lease_id = p_lease;
  if comm < 0 then
    raise exception 'I4 violated: COMMITTED_UNSETTLED balance % below zero', comm using errcode = 'check_violation';
  end if;
  if buyer_c > lease_cap then
    raise exception 'I16 violated: commitment % exceeds lease cap %', buyer_c, lease_cap using errcode = 'check_violation';
  end if;
  if buyer_c <> open_and_sinks + capd then
    raise exception 'I16 violated: commitment % != open % + captured %', buyer_c, open_and_sinks, capd using errcode = 'check_violation';
  end if;
  if seller_cost > capd - fees then
    raise exception 'I13 violated: seller accrual % exceeds net captured %', seller_cost, capd - fees using errcode = 'check_violation';
  end if;
  select coalesce(sum(amount_minor) filter (where status in ('completed', 'reversed')), 0),
         coalesce(sum(fee_minor) filter (where status in ('completed', 'reversed')), 0),
         coalesce(sum(amount_minor) filter (where status in ('intent', 'pending', 'unknown')), 0),
         coalesce(sum(amount_minor) filter (where status = 'reversed'), 0),
         coalesce(sum(amount_minor) filter (where status in ('intent', 'pending', 'completed', 'unknown', 'reversed')), 0)
    into cap_moved, cap_fee, cap_inflight, cap_rev, cap_counted from public.captures where lease_id = p_lease;
  if cap_counted > lease_cap then
    raise exception 'I1 violated: counted captures % exceed lease cap %', cap_counted, lease_cap using errcode = 'check_violation';
  end if;
  if cap_moved <> capd or cap_fee <> fees then
    raise exception 'I17 violated: completed captures (% / fee %) differ from capture postings (% / fee %)', cap_moved, cap_fee, capd, fees using errcode = 'check_violation';
  end if;
  if cap_rev <> rev_post then
    raise exception 'I17 violated: reversed captures % differ from reversal postings %', cap_rev, rev_post using errcode = 'check_violation';
  end if;
  if cap_inflight > comm then
    raise exception 'I17 violated: in-flight captures % exceed committed usage %', cap_inflight, comm using errcode = 'check_violation';
  end if;
  if lease_st in ('active', 'closed') and buyer_c <> lease_cap then
    raise exception 'I16 violated: authorize posting % must equal cap % on a live lease', buyer_c, lease_cap using errcode = 'check_violation';
  end if;
end $$;

create function ledger_deferred_check() returns trigger language plpgsql set search_path = pg_catalog, pg_temp as $$
declare d bigint; c bigint; leases_in_group integer; bal bigint; unsettled_limit bigint; comm bigint; honor timestamptz;
begin
  perform public.lock_lease(new.lease_id);
  select coalesce(sum(amount_minor) filter (where direction = 'D'), 0),
         coalesce(sum(amount_minor) filter (where direction = 'C'), 0),
         count(distinct lease_id)
    into d, c, leases_in_group from public.ledger_entries where group_id = new.group_id;
  if (select count(distinct (ref_type, ref_id)) from public.ledger_entries where group_id = new.group_id) <> 1 then
    raise exception 'I2 violated: a group contains exactly one ref_type and ref_id' using errcode = 'check_violation';
  end if;
  if leases_in_group <> 1 then
    raise exception 'I2 violated: group % spans % leases', new.group_id, leases_in_group using errcode = 'check_violation';
  end if;
  if d <> c then
    raise exception 'I2 violated: group % unbalanced, debits % credits %', new.group_id, d, c using errcode = 'check_violation';
  end if;
  if new.ref_type='clawback' and exists (
    select 1 from public.ledger_entries where group_id=new.group_id group by seller_id
    having sum(case direction when 'D' then amount_minor else -amount_minor end)<>0) then
    raise exception 'I2 violated: clawback must balance for each seller' using errcode='check_violation';
  end if;
  if new.account in ('HOLD_AVAILABLE', 'COMMITTED_UNSETTLED') or (new.account = 'CAPTURED_GROSS' and new.ref_type <> 'reversal') then
    select coalesce(sum(case direction when 'D' then amount_minor else -amount_minor end), 0) into bal
      from public.ledger_entries where lease_id = new.lease_id and account = new.account;
    if bal < 0 then
      raise exception 'I4 violated: account % balance % below zero', new.account, bal using errcode = 'check_violation';
    end if;
  elsif new.account = 'SELLER_PAYABLE' then
    select coalesce(sum(case direction when 'C' then amount_minor else -amount_minor end), 0) into bal
      from public.ledger_entries where lease_id = new.lease_id and account = new.account and seller_id = new.seller_id;
    if bal < 0 then
      raise exception 'I4 violated: SELLER_PAYABLE balance % below zero for seller %', bal, new.seller_id using errcode = 'check_violation';
    end if;
  end if;
  if new.ref_type = 'commit' and new.account = 'COMMITTED_UNSETTLED' then
    -- A commit is either a whole job reserve or a served tool call at exactly its price, posted in this group.
    if not (exists (select 1 from public.jobs j where j.id::text = new.ref_id and j.lease_id = new.lease_id and j.amount_minor = new.amount_minor)
         or exists (select 1 from public.tool_calls t where t.id::text = new.ref_id and t.lease_id = new.lease_id and t.status = 'served'
                    and t.price_minor = new.amount_minor and t.ledger_group_id = new.group_id)) then
      raise exception 'I17 violated: commit % matches no job reserve or served tool call at that amount', new.ref_id using errcode = 'check_violation';
    end if;
    select unsettled_limit_minor into unsettled_limit from public.leases where id = new.lease_id;
    select coalesce(sum(case direction when 'D' then amount_minor else -amount_minor end), 0) into comm
      from public.ledger_entries where lease_id = new.lease_id and account = 'COMMITTED_UNSETTLED';
    if comm > unsettled_limit then
      raise exception 'I18 violated: committed unsettled % exceeds the exposure limit %', comm, unsettled_limit using errcode = 'check_violation';
    end if;
    select honor_until into honor from public.authorizations where lease_id = new.lease_id and status in ('created', 'partially_captured');
    if honor is null or honor < now() then
      raise exception 'I18 violated: no live authorization inside its honor period, reauthorize first' using errcode = 'check_violation';
    end if;
  end if;
  perform public.check_lease_consistency(new.lease_id);
  perform public.check_allocations(new.lease_id);
  return null;
end $$;
create constraint trigger ledger_commit_checks after insert on ledger_entries
  deferrable initially deferred for each row execute function ledger_deferred_check();

create function captures_deferred_check() returns trigger language plpgsql set search_path = pg_catalog, pg_temp as $$
begin
  perform public.lock_lease(new.lease_id);
  perform public.check_lease_consistency(new.lease_id);
  perform public.check_allocations(new.lease_id);
  return null;
end $$;
create constraint trigger captures_commit_checks after insert or update on captures
  deferrable initially deferred for each row execute function captures_deferred_check();

-- Lease state machine. Active needs the authorize posting to equal the cap and a live authorization.
-- Closed needs nothing open, nothing in flight, and every authorization finished (voided, captured, expired, denied or superseded).
create function enforce_lease_transition() returns trigger language plpgsql set search_path = pg_catalog, pg_temp as $$
declare buyer_c bigint; hold bigint; comm bigint; unresolved integer; inflight integer; live integer;
begin
  if new.state = old.state then return new; end if;
  if not ((old.state = 'pending_approval' and new.state in ('active', 'failed', 'expired'))
       or (old.state = 'active' and new.state in ('closed', 'expired', 'failed'))
       or (old.state in ('expired', 'failed') and new.state = 'closed')) then
    raise exception 'Lease state % to % is not allowed', old.state, new.state using errcode = 'check_violation';
  end if;
  if new.state = 'active' then
    select coalesce(sum(case when account = 'BUYER_COMMITMENT' then (case direction when 'C' then amount_minor else -amount_minor end) end), 0)
      into buyer_c from public.ledger_entries where lease_id = new.id;
    select count(*) into live from public.authorizations where lease_id = new.id and status in ('created', 'partially_captured');
    if buyer_c <> new.cap_minor or live <> 1 then
      raise exception 'I16 violated: a lease goes active only with an authorize posting equal to the cap (%) and one live authorization (%)', buyer_c, live using errcode = 'check_violation';
    end if;
  end if;
  if new.state = 'closed' then
    perform public.check_allocations(new.id);
    if public.unaccrued_captures(new.id) then
      raise exception 'I14 violated: close with unaccrued completed capture allocations' using errcode = 'check_violation';
    end if;
    select coalesce(sum(case direction when 'D' then amount_minor else -amount_minor end) filter (where account = 'HOLD_AVAILABLE'), 0),
           coalesce(sum(case direction when 'D' then amount_minor else -amount_minor end) filter (where account = 'COMMITTED_UNSETTLED'), 0)
      into hold, comm from public.ledger_entries where lease_id = new.id;
    select count(*) into unresolved from public.paypal_calls where lease_id = new.id and state in ('intent', 'sent', 'unknown');
    select count(*) into inflight from public.captures where lease_id = new.id and status in ('intent', 'pending', 'unknown');
    select count(*) into live from public.authorizations where lease_id = new.id and status in ('created', 'partially_captured');
    if hold <> 0 or comm <> 0 or unresolved > 0 or inflight > 0 or live > 0 then
      raise exception 'I14 violated: close with hold %, committed %, unresolved calls %, in-flight captures %, live authorizations %', hold, comm, unresolved, inflight, live using errcode = 'check_violation';
    end if;
  end if;
  return new;
end $$;
create trigger leases_transition before update of state on leases for each row execute function enforce_lease_transition();

-- Exact cents only. Longer fractions are refused rather than rounded.
create function paypal_minor(value text) returns bigint language plpgsql immutable set search_path = pg_catalog, pg_temp as $$
begin
  if value is null or value !~ '^[0-9]+\.[0-9]{2}$' then
    raise exception 'I17 violated: PayPal amount and fee require exactly two decimals' using errcode = 'check_violation';
  end if;
  return (value::numeric * 100)::bigint;
end $$;

-- Split the known net deterministically in ref_id order. Cumulative integer rounding
-- assigns every cent exactly once, including the last cent of a multi-seller batch.
create view allocation_nets as
select a.capture_id, a.lease_id, a.ref_id, a.amount_minor,
  (floor((c.amount_minor-c.fee_minor)::numeric * sum(a.amount_minor) over w / c.amount_minor)
   - floor((c.amount_minor-c.fee_minor)::numeric * (sum(a.amount_minor) over w-a.amount_minor) / c.amount_minor))::bigint as net_minor
from public.capture_allocations a join public.captures c on c.id=a.capture_id
where c.status in ('completed','reversed')
window w as (partition by a.capture_id order by a.ref_id rows unbounded preceding);

create view allocation_earnings as
with refs as (
  select n.*, coalesce(j.seller_id,t.seller_id) as seller_id,
    coalesce(d.id::text,n.ref_id) as accrual_ref,
    coalesce((select sum(e.amount_minor) from public.ledger_entries e
      where e.lease_id=n.lease_id and e.ref_type='accrue' and e.account='SELLER_COST' and e.direction='D'
        and e.ref_id=coalesce(d.id::text,n.ref_id)),0) as accrued
  from public.allocation_nets n
  left join public.jobs j on j.id::text=n.ref_id and j.lease_id=n.lease_id
  left join public.decisions d on d.job_id=j.id and d.outcome in ('release','partial')
  left join public.tool_calls tc on tc.id::text=n.ref_id and tc.lease_id=n.lease_id
  left join public.tools t on t.id=tc.tool_id
), shares as (
  select *, sum(net_minor) over (partition by lease_id,ref_id) as total_net,
    sum(net_minor) over (partition by lease_id,ref_id order by capture_id rows unbounded preceding) as running_net
  from refs
)
select *, (case when total_net=0 then 0 else
  floor(accrued*running_net/total_net)-floor(accrued*(running_net-net_minor)/total_net) end)::bigint as earned_minor
from shares;

create function allocation_insert_guard() returns trigger language plpgsql set search_path = pg_catalog, pg_temp as $$
declare c public.captures%rowtype;
begin
  perform public.lock_lease(new.lease_id);
  select * into c from public.captures where id=new.capture_id;
  if c.lease_id is distinct from new.lease_id or c.status <> 'intent' then
    raise exception 'I9 violated: allocations need an intent capture on the same lease' using errcode = 'check_violation';
  end if;
  if exists (select 1 from public.ledger_entries e where e.lease_id=new.lease_id and e.ref_type='accrue'
    and (e.ref_id=new.ref_id or e.ref_id in (select id::text from public.decisions where job_id::text=new.ref_id))) then
    raise exception 'I9 violated: settle all captures of a ref before its single accrual' using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger allocations_insert before insert on capture_allocations for each row execute function allocation_insert_guard();
create trigger allocations_no_update before update or delete on capture_allocations for each row execute function forbid_all_changes();
create trigger allocations_no_truncate before truncate on capture_allocations for each statement execute function forbid_all_changes();

create function check_allocations(l uuid) returns void language plpgsql set search_path = pg_catalog, pg_temp as $$
declare r record; committed bigint; returned bigint; allocated bigint; max_pay bigint; accrued bigint; net bigint;
begin
  if exists (select 1 from public.captures c where c.lease_id=l and c.amount_minor < coalesce(c.fee_minor,0)) then
    raise exception 'I17 violated: capture fee exceeds gross' using errcode = 'check_violation';
  end if;
  if exists (select 1 from public.captures c where c.lease_id=l and c.amount_minor <>
    (select coalesce(sum(a.amount_minor),0) from public.capture_allocations a where a.capture_id=c.id)) then
    raise exception 'I9 violated: capture allocations must sum to the capture amount' using errcode = 'check_violation';
  end if;
  if exists (
    select 1 from public.capture_allocations a join public.captures c on c.id=a.capture_id
    where a.lease_id=l and (c.lease_id<>a.lease_id or not (
      exists (select 1 from public.tool_calls t where t.id::text=a.ref_id and t.lease_id=l and t.status='served' and c.decision_id is null)
      or exists (select 1 from public.jobs j join public.decisions d on d.job_id=j.id and d.outcome in ('release','partial')
        where j.id::text=a.ref_id and j.lease_id=l and (c.decision_id is null or c.decision_id=d.id))))) then
    raise exception 'I9 violated: allocation needs its own paying job or served tool on the lease' using errcode = 'check_violation';
  end if;
  -- Declined allocations become writeoff consumption, never another ref's usage.
  if exists (select 1 from public.captures c where c.lease_id=l and c.status in ('declined','denied')
    and c.amount_minor <> (select coalesce(sum(amount_minor),0) from public.ledger_entries
      where lease_id=l and ref_type='writeoff' and ref_id=c.id::text and account='WRITTEN_OFF' and direction='D')) then
    raise exception 'I17 violated: decline needs its full writeoff in the same transaction' using errcode = 'check_violation';
  end if;
  for r in select ref_id from public.capture_allocations where lease_id=l
    union select ref_id from public.ledger_entries where lease_id=l and ref_type in ('commit','return') loop
    select coalesce(sum(amount_minor) filter (where ref_type='commit' and account='COMMITTED_UNSETTLED' and direction='D'),0),
      coalesce(sum(amount_minor) filter (where ref_type='return' and account='COMMITTED_UNSETTLED' and direction='C'),0)
      into committed,returned from public.ledger_entries where lease_id=l and ref_id=r.ref_id;
    select coalesce(sum(amount_minor),0) into allocated from public.capture_allocations where lease_id=l and ref_id=r.ref_id;
    if allocated+returned > committed then
      raise exception 'I9/I17 violated: per-ref allocations/writeoff % plus returned % exceed commit % for %', allocated,returned,committed,r.ref_id using errcode='check_violation';
    end if;
    select d.amount_minor into max_pay from public.decisions d where d.job_id::text=r.ref_id and d.lease_id=l and d.outcome in ('release','partial');
    if max_pay is not null and allocated>max_pay then
      raise exception 'I9 violated: job allocations exceed its paying decision' using errcode='check_violation';
    end if;
  end loop;
  for r in select ref_id,sum(amount_minor) as amount from public.ledger_entries
    where lease_id=l and ref_type='accrue' and account='SELLER_COST' and direction='D' group by ref_id loop
    select coalesce(sum(n.net_minor),0) into net from public.allocation_nets n
      where n.lease_id=l and (n.ref_id=r.ref_id or n.ref_id in (select job_id::text from public.decisions where id::text=r.ref_id));
    if r.amount > net then
      raise exception 'I17 violated: accrual exceeds this ref allocation net %',net using errcode='check_violation';
    end if;
  end loop;
  for r in select ref_id,seller_id,sum(amount_minor) as amount from public.ledger_entries
    where lease_id=l and ref_type='clawback' and account='SELLER_PAYABLE' and direction='D' group by ref_id,seller_id loop
    select coalesce(sum(a.earned_minor),0) into accrued from public.allocation_earnings a join public.captures c on c.id=a.capture_id
      where a.lease_id=l and a.capture_id::text=r.ref_id and a.seller_id=r.seller_id and c.status='reversed';
    if r.amount>accrued then
      raise exception 'I17 violated: clawback exceeds attributable reversed accrual %',accrued using errcode='check_violation';
    end if;
  end loop;
end $$;
create constraint trigger allocations_commit_checks after insert on capture_allocations
  deferrable initially deferred for each row execute function captures_deferred_check();

create function unaccrued_captures(l uuid) returns boolean language sql stable set search_path = pg_catalog, pg_temp as $$
  select exists (select 1 from public.allocation_earnings a join public.captures c on c.id=a.capture_id
    where a.lease_id=l and c.status='completed' and a.net_minor>a.earned_minor)
$$;
create function uncovered_clawbacks(l uuid) returns boolean language sql stable set search_path = pg_catalog, pg_temp as $$
  select exists (select 1 from public.allocation_earnings a join public.captures c on c.id=a.capture_id
    where a.lease_id=l and c.status='reversed' group by a.capture_id,a.seller_id
    having sum(a.earned_minor) > coalesce((select sum(e.amount_minor) from public.ledger_entries e
      where e.lease_id=l and e.ref_type='clawback' and e.ref_id=a.capture_id::text and e.seller_id=a.seller_id
        and e.account='SELLER_PAYABLE' and e.direction='D'),0))
$$;

create function decision_deferred_check() returns trigger language plpgsql set search_path = pg_catalog, pg_temp as $$
begin
  perform public.lock_lease(new.lease_id);
  perform 1 from public.jobs where id=new.job_id for update;
  if new.outcome <> 'hold' and exists (select 1 from public.verdicts where job_id=new.job_id and round>new.round) then
    raise exception 'I11 violated: final decision has verdicts in a later round' using errcode='check_violation';
  end if;
  return null;
end $$;

create function validate_accrual(l uuid,ref text,amount bigint) returns void language plpgsql set search_path=pg_catalog,pg_temp as $$
declare usage_ref text; net bigint;
begin
  select coalesce((select job_id::text from public.decisions where lease_id=l and id::text=ref),ref) into usage_ref;
  if exists (select 1 from public.capture_allocations a join public.captures c on c.id=a.capture_id
    where a.lease_id=l and a.ref_id=usage_ref and c.status in ('intent','pending','unknown','reversed')) then
    raise exception 'I17 violated: accrual waits for resolved, unreversed capture allocations' using errcode='check_violation';
  end if;
  select coalesce(sum(net_minor),0) into net from public.allocation_nets where lease_id=l and ref_id=usage_ref;
  if amount<>net then
    raise exception 'I13/I17 violated: the single accrual must equal this ref full allocated net %',net using errcode='check_violation';
  end if;
end $$;
create constraint trigger decisions_commit_checks after insert on decisions
  deferrable initially deferred for each row execute function decision_deferred_check();

create function payout_deferred_check() returns trigger language plpgsql set search_path = pg_catalog, pg_temp as $$
begin
  perform public.lock_lease(new.lease_id);
  if exists (select 1 from public.payouts p where p.id=new.id and p.state='success' and p.amount_minor <>
    (select coalesce(sum(amount_minor),0) from public.ledger_entries where lease_id=p.lease_id and ref_type='payout'
      and ref_id=p.id::text and account='SELLER_PAYABLE' and direction='D' and seller_id=p.seller_id)) then
    raise exception 'I13 violated: payout success needs its full posting in the same transaction' using errcode='check_violation';
  end if;
  return null;
end $$;
create constraint trigger payouts_commit_checks after insert or update on payouts
  deferrable initially deferred for each row execute function payout_deferred_check();

-- Allocate a capture/seller clawback back to its contributing refs, with the same
-- cumulative-cent rule. This prevents a cancelled job consuming metered earnings.
create view allocation_recoveries as
with recovered as (
  select a.*, coalesce((select sum(e.amount_minor) from public.ledger_entries e
    where e.lease_id=a.lease_id and e.ref_type='clawback' and e.ref_id=a.capture_id::text
      and e.seller_id=a.seller_id and e.account='SELLER_PAYABLE' and e.direction='D'),0) as recovered,
    sum(earned_minor) over (partition by capture_id,seller_id) as total_earned,
    sum(earned_minor) over (partition by capture_id,seller_id order by ref_id rows unbounded preceding) as running_earned
  from public.allocation_earnings a
)
select *, (case when total_earned=0 then 0 else floor(recovered*running_earned/total_earned)
  - floor(recovered*(running_earned-earned_minor)/total_earned) end)::bigint as recovered_minor from recovered;

create function check_payout_funding(l uuid,s uuid,src text,d uuid,amount bigint,exclude_id uuid) returns void
language plpgsql set search_path = pg_catalog, pg_temp as $$
declare accrued bigint; recovered bigint; reserved bigint;
begin
  select coalesce(sum(e.amount_minor),0) into accrued from public.ledger_entries e
    where e.lease_id=l and e.seller_id=s and e.ref_type='accrue' and e.account='SELLER_PAYABLE' and e.direction='C'
      and ((src='job' and e.ref_id=d::text) or (src='metered' and exists (select 1 from public.tool_calls t where t.id::text=e.ref_id)));
  select coalesce(sum(recovered_minor),0) into recovered from public.allocation_recoveries a
    where a.lease_id=l and a.seller_id=s and ((src='job' and a.accrual_ref=d::text)
      or (src='metered' and exists (select 1 from public.tool_calls t where t.id::text=a.accrual_ref)));
  select coalesce(sum(amount_minor),0) into reserved from public.payouts p
    where p.lease_id=l and p.seller_id=s and p.source=src and p.state<>'failed' and p.id<>exclude_id
      and (src='metered' or p.decision_id=d);
  if reserved+amount > accrued-recovered then
    raise exception 'I13 violated: payout exceeds its source accrual after clawback (accrued %, recovered %, reserved %)',accrued,recovered,reserved using errcode='check_violation';
  end if;
end $$;
