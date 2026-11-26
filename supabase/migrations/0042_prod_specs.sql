-- Προδιαγραφές παραγωγής (ίδια μορφή εξαγωγής ERP με του Repack) για τη Ζήτηση περιεκτών — χωριστά από το Repack.
create table if not exists public.prod_spec_lines (
  id bigserial primary key,
  spec_id text not null,
  product_code text not null,
  product_desc text,
  code text not null,
  description text,
  qty numeric not null,
  unit text
);
create index if not exists prod_spec_lines_product on public.prod_spec_lines (product_code);
alter table public.prod_spec_lines enable row level security;
create policy prod_spec_lines_read on public.prod_spec_lines for select to authenticated using (true);

create or replace function public.prod_specs_replace(p_rows jsonb, p_file text)
returns integer language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  if auth.uid() is null then raise exception 'Απαιτείται σύνδεση'; end if;
  delete from public.prod_spec_lines where true;
  insert into public.prod_spec_lines (spec_id, product_code, product_desc, code, description, qty, unit)
  select r->>'spec_id', upper(trim(r->>'product_code')), r->>'product_desc', upper(trim(r->>'code')), r->>'description', (r->>'qty')::numeric, r->>'unit'
  from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) r;
  get diagnostics n = row_count;
  insert into public.demand_uploads (kind, file_name, rows, uploaded_at, uploaded_by)
  values ('specs', p_file, n, now(), coalesce(auth.jwt()->>'email', ''))
  on conflict (kind) do update set file_name = excluded.file_name, rows = excluded.rows, uploaded_at = now(), uploaded_by = excluded.uploaded_by;
  insert into public.wms_live (key, at, items, n) values ('demand', now(), '{}', n)
  on conflict (key) do update set at = now(), items = excluded.items, n = excluded.n;
  return n;
end $$;
revoke all on function public.prod_specs_replace(jsonb, text) from public, anon;
grant execute on function public.prod_specs_replace(jsonb, text) to authenticated;

alter table public.demand_uploads drop constraint if exists demand_uploads_kind_check;
alter table public.demand_uploads add constraint demand_uploads_kind_check check (kind in ('plan', 'orders', 'specs'));
