-- API-owned registry. Register only dedicated leases whose journal can be public.
create table if not exists public.showcase_leases (
  lease_id uuid primary key references public.leases(id),
  published_at timestamptz
);
revoke all on public.showcase_leases from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on public.showcase_leases from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on public.showcase_leases from authenticated;
  end if;
end $$;
grant select, insert, update (published_at) on public.showcase_leases to pashadhara_app;
