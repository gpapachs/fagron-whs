-- Το PostgREST (pg_safeupdate) απορρίπτει delete χωρίς where -> "where true".
create or replace function public.wms_item_pack_upload(p_rows jsonb, p_packs jsonb)
returns integer
language plpgsql security definer set search_path = public
as $$
declare n integer;
begin
  delete from public.wms_item_pack where true;
  insert into public.wms_item_pack (item, pieces_per_pal, pal_to_mu1, units)
  select upper(r->>'item'), nullif(r->>'ppp', '')::numeric, nullif(r->>'p2m', '')::numeric, nullif(r->>'units', '')
  from jsonb_array_elements(case when jsonb_typeof(p_rows) = 'array' then p_rows else '[]'::jsonb end) r where coalesce(r->>'item', '') <> ''
  on conflict (item) do nothing;
  get diagnostics n = row_count;
  if jsonb_typeof(p_packs) = 'array' and jsonb_array_length(p_packs) > 0 then
    delete from public.wms_packs where true;
    insert into public.wms_packs (id, code, descr)
    select (r->>'id')::int, r->>'code', r->>'descr' from jsonb_array_elements(p_packs) r on conflict (id) do nothing;
  end if;
  return n;
end $$;
