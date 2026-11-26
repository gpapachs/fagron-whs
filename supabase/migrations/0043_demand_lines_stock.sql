-- Ζήτηση περιεκτών: απόθεμα τελικού από το αρχείο ανοιχτών παραγγελιών (για να μετράει μόνο ό,τι πρέπει να παραχθεί).
alter table public.demand_lines add column if not exists stock numeric;
-- demand_replace: + stock (βλ. 0041)
create or replace function public.demand_replace(p_kind text, p_rows jsonb, p_file text)
returns integer language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  if auth.uid() is null then raise exception 'Απαιτείται σύνδεση'; end if;
  if p_kind not in ('plan', 'orders') then raise exception 'Άγνωστο είδος'; end if;
  delete from public.demand_lines where kind = p_kind;
  insert into public.demand_lines (kind, product, description, qty, due, ref, row_no, stock)
  select p_kind, upper(trim(r->>'product')), nullif(r->>'description', ''), (r->>'qty')::numeric,
         nullif(r->>'due', '')::date, nullif(r->>'ref', ''), (r->>'row')::int, nullif(r->>'stock', '')::numeric
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
