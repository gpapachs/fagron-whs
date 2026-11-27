-- Ανάλυση φορτίου σε γραμμές (τύπος παλέτας / δέμα, τεμάχια, διαστάσεις, βάρος) + αποθηκευμένες επιλογές (π.χ. θερμοκρασίες).
alter table public.rfqs add column if not exists cargo jsonb;
create table if not exists public.logistics_options (
  kind text not null,
  value text not null,
  created_at timestamptz not null default now(),
  created_by text,
  primary key (kind, value)
);
alter table public.logistics_options enable row level security;
drop policy if exists logistics_options_all on public.logistics_options;
create policy logistics_options_all on public.logistics_options for all to authenticated using (true) with check (true);
insert into public.logistics_options (kind, value)
select 'temp', t from (select distinct trim(temp) t from public.rfqs where coalesce(trim(temp), '') <> '') x
on conflict do nothing;
