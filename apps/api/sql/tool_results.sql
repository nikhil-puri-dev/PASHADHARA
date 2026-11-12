-- API-owned table (not part of the frozen contract). Apply after schema.sql and roles.sql, as the table owner.
-- Stores the product of a served paid call so a retry with the same idempotency key replays it for free.
-- Written in the same transaction as the charge: either both exist or neither does.
create table if not exists public.tool_results (
  lease_id uuid not null references public.leases(id),
  idempotency_key text not null,
  tool_call_id uuid not null,
  result jsonb not null,
  created_at timestamptz not null default now(),
  primary key (lease_id, idempotency_key),
  foreign key (tool_call_id) references public.tool_calls(id)
);
revoke all on public.tool_results from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on public.tool_results from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on public.tool_results from authenticated;
  end if;
end $$;
grant select, insert on public.tool_results to pashadhara_app;
