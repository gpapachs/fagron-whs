-- Ζήτηση περιεκτών: Excel πλάνου παραγωγής / ανοιχτών παραγγελιών (τελικά προϊόντα) -> μέσω προδιαγραφών
-- (repack_recipes / repack_components) -> υλικά συσκευασίας (κωδικοί όχι 00* / 71*).
create table if not exists public.demand_lines (
  id bigserial primary key,
  kind text not null check (kind in ('plan', 'orders')),
  product text not null,
  description text,
  qty numeric not null,
  due date,
  ref text,
  row_no integer
);
create index if not exists demand_lines_kind on public.demand_lines (kind);
alter table public.demand_lines enable row level security;
create policy demand_lines_read on public.demand_lines for select to authenticated using (true);

create table if not exists public.demand_uploads (
  kind text primary key check (kind in ('plan', 'orders')),
  file_name text,
  rows integer,
  uploaded_at timestamptz not null default now(),
  uploaded_by text
);
alter table public.demand_uploads enable row level security;
create policy demand_uploads_read on public.demand_uploads for select to authenticated using (true);

create or replace function public.demand_replace(p_kind text, p_rows jsonb, p_file text)
returns integer language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  if auth.uid() is null then raise exception 'Απαιτείται σύνδεση'; end if;
  if p_kind not in ('plan', 'orders') then raise exception 'Άγνωστο είδος'; end if;
  delete from public.demand_lines where kind = p_kind;
  insert into public.demand_lines (kind, product, description, qty, due, ref, row_no)
  select p_kind, upper(trim(r->>'product')), nullif(r->>'description', ''), (r->>'qty')::numeric,
         nullif(r->>'due', '')::date, nullif(r->>'ref', ''), (r->>'row')::int
  from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) r
  where coalesce(r->>'product', '') <> '' and coalesce(r->>'qty', '') <> '';
  get diagnostics n = row_count;
  insert into public.demand_uploads (kind, file_name, rows, uploaded_at, uploaded_by)
  values (p_kind, p_file, n, now(), coalesce(auth.jwt()->>'email', ''))
  on conflict (kind) do update set file_name = excluded.file_name, rows = excluded.rows, uploaded_at = now(), uploaded_by = excluded.uploaded_by;
  insert into public.wms_live (key, at, items, n) values ('demand', now(), '{}', n)
  on conflict (key) do update set at = now(), items = excluded.items, n = excluded.n;
  return n;
end $$;
revoke all on function public.demand_replace(text, jsonb, text) from public, anon;
grant execute on function public.demand_replace(text, jsonb, text) to authenticated;

create or replace function public.demand_clear(p_kind text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Απαιτείται σύνδεση'; end if;
  delete from public.demand_lines where kind = p_kind;
  delete from public.demand_uploads where kind = p_kind;
  insert into public.wms_live (key, at, items, n) values ('demand', now(), '{}', 0)
  on conflict (key) do update set at = now(), items = excluded.items, n = excluded.n;
end $$;
revoke all on function public.demand_clear(text) from public, anon;
grant execute on function public.demand_clear(text) to authenticated;
