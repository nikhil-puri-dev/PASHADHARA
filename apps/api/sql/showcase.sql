-- API-owned registry. Register only dedicated leases whose journal can be public.
create table if not exists public.showcase_leases (
  lease_id uuid primary key references public.leases(id),
  published_at timestamptz
);
revoke all on public.showcase_leases from public;
grant select, insert, update (published_at) on public.showcase_leases to pashadhara_app;
