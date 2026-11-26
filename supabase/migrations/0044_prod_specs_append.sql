-- Προδιαγραφές παραγωγής: ανέβασμα σε κομμάτια (p_append) για μεγάλα BOM.
drop function if exists public.prod_specs_replace(jsonb, text);
create or replace function public.prod_specs_replace(p_rows jsonb, p_file text, p_append boolean default false)
returns integer language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  if auth.uid() is null then raise exception 'Απαιτείται σύνδεση'; end if;
  if not p_append then delete from public.prod_spec_lines where true; end if;
  insert into public.prod_spec_lines (spec_id, product_code, product_desc, code, description, qty, unit)
  select r->>'spec_id', upper(trim(r->>'product_code')), r->>'product_desc', upper(trim(r->>'code')), r->>'description', (r->>'qty')::numeric, r->>'unit'
  from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) r;
  select count(*) into n from public.prod_spec_lines;
  insert into public.demand_uploads (kind, file_name, rows, uploaded_at, uploaded_by)
  values ('specs', p_file, n, now(), coalesce(auth.jwt()->>'email', ''))
  on conflict (kind) do update set file_name = excluded.file_name, rows = excluded.rows, uploaded_at = now(), uploaded_by = excluded.uploaded_by;
  insert into public.wms_live (key, at, items, n) values ('demand', now(), '{}', n)
  on conflict (key) do update set at = now(), items = excluded.items, n = excluded.n;
  return n;
end $$;
revoke all on function public.prod_specs_replace(jsonb, text, boolean) from public, anon;
grant execute on function public.prod_specs_replace(jsonb, text, boolean) to authenticated;
