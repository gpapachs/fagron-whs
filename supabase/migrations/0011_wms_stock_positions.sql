-- Fagron -- απόθεμα WMS ανά ΘΕΣΗ (για τη σελίδα «Απόθεμα» με φίλτρα / εξαγωγές).
-- Ο πίνακας ξαναγεμίζει από το sync, άρα ασφαλές να ξαναδημιουργηθεί.
drop table if exists public.wms_stock;
create table public.wms_stock (
  item text not null,
  position text not null default '',
  area text not null default '',
  lot text not null default '',
  serial text not null default '',
  expiry date,
  qty numeric not null default 0,
  primary key (item, position, lot, serial)
);
create index wms_stock_position_idx on public.wms_stock (position);
alter table public.wms_stock enable row level security;
create policy wms_stock_read on public.wms_stock for select to authenticated using (true);
grant select on public.wms_stock to authenticated;

-- stock: [{item, position, area, lot, serial, expiry, qty}]  (δέχεται και το παλιό «positions»)
create or replace function public.wms_upload(p_items jsonb, p_stock jsonb, p_first boolean)
returns int language plpgsql security definer set search_path = public as $$
declare n int := 0;
begin
  if auth.uid() is null then raise exception 'Απαιτείται σύνδεση'; end if;
  if jsonb_typeof(coalesce(p_items, '[]')) <> 'array' or jsonb_typeof(coalesce(p_stock, '[]')) <> 'array' then
    raise exception 'Λάθος μορφή';
  end if;

  insert into public.wms_items (code, description, description_en, updated_at)
  select distinct on (upper(trim(i->>'code')))
         upper(trim(i->>'code')), coalesce(trim(i->>'description'), ''), coalesce(trim(i->>'description_en'), ''), now()
  from jsonb_array_elements(coalesce(p_items, '[]')) t(i)
  where coalesce(trim(i->>'code'), '') <> ''
  on conflict (code) do update
    set description = excluded.description, description_en = excluded.description_en, updated_at = now()
    where wms_items.description is distinct from excluded.description
       or wms_items.description_en is distinct from excluded.description_en;

  if p_first then delete from public.wms_stock where true; end if;

  insert into public.wms_stock (item, position, lot, serial, area, expiry, qty)
  select upper(trim(s->>'item')),
         coalesce(trim(coalesce(s->>'position', s->>'positions')), ''),
         coalesce(trim(s->>'lot'), ''), coalesce(trim(s->>'serial'), ''),
         max(coalesce(trim(s->>'area'), '')),
         min(nullif(s->>'expiry', '')::date), sum(coalesce(nullif(s->>'qty', '')::numeric, 0))
  from jsonb_array_elements(coalesce(p_stock, '[]')) t(s)
  where coalesce(trim(s->>'item'), '') <> ''
  group by 1, 2, 3, 4
  on conflict (item, position, lot, serial) do update
    set qty = wms_stock.qty + excluded.qty,
        expiry = least(wms_stock.expiry, excluded.expiry);
  get diagnostics n = row_count;
  return n;
end;
$$;
revoke all on function public.wms_upload(jsonb, jsonb, boolean) from public, anon;
grant execute on function public.wms_upload(jsonb, jsonb, boolean) to authenticated;
