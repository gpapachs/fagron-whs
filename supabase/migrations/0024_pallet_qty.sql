-- Ποσότητα ανά παλέτα: (α) από το WMS (ms_Item.PiecesPerPalete / PalPiecesToMu1 και οι
-- μονάδες συσκευασίας ms_ItemUnit), (β) χειροκίνητα από τους χρήστες -- η χειροκίνητη υπερισχύει.
create table if not exists public.wms_item_pack (
  item text primary key,
  pieces_per_pal numeric,
  pal_to_mu1 numeric,
  units text,            -- π.χ. "2:479;3:24" (PackId:Rel)
  synced_at timestamptz not null default now()
);
create table if not exists public.wms_packs (id integer primary key, code text, descr text);
create table if not exists public.item_pallet_qty (
  item text primary key,
  qty numeric not null check (qty > 0),
  updated_by text,
  updated_at timestamptz not null default now()
);
alter table public.wms_item_pack enable row level security;
alter table public.wms_packs enable row level security;
alter table public.item_pallet_qty enable row level security;
create policy wms_item_pack_read on public.wms_item_pack for select to authenticated using (true);
create policy wms_packs_read on public.wms_packs for select to authenticated using (true);
create policy item_pallet_qty_read on public.item_pallet_qty for select to authenticated using (true);

create or replace function public.wms_item_pack_upload(p_rows jsonb, p_packs jsonb)
returns integer
language plpgsql security definer set search_path = public
as $$
declare n integer;
begin
  delete from public.wms_item_pack;
  insert into public.wms_item_pack (item, pieces_per_pal, pal_to_mu1, units)
  select upper(r->>'item'), nullif(r->>'ppp', '')::numeric, nullif(r->>'p2m', '')::numeric, nullif(r->>'units', '')
  from jsonb_array_elements(coalesce(p_rows, '[]')) r where coalesce(r->>'item', '') <> ''
  on conflict (item) do nothing;
  get diagnostics n = row_count;
  if jsonb_array_length(coalesce(p_packs, '[]')) > 0 then
    delete from public.wms_packs;
    insert into public.wms_packs (id, code, descr)
    select (r->>'id')::int, r->>'code', r->>'descr' from jsonb_array_elements(p_packs) r on conflict (id) do nothing;
  end if;
  return n;
end $$;
revoke all on function public.wms_item_pack_upload(jsonb, jsonb) from public, anon;
grant execute on function public.wms_item_pack_upload(jsonb, jsonb) to authenticated;

-- χειροκίνητη ποσότητα ανά παλέτα (κενό / 0 = διαγραφή)
create or replace function public.item_pallet_set(p_item text, p_qty numeric)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if p_qty is null or p_qty <= 0 then
    delete from public.item_pallet_qty where item = upper(p_item);
  else
    insert into public.item_pallet_qty (item, qty, updated_by, updated_at)
    values (upper(p_item), p_qty, coalesce(auth.jwt()->>'email', ''), now())
    on conflict (item) do update set qty = excluded.qty, updated_by = excluded.updated_by, updated_at = now();
  end if;
end $$;
revoke all on function public.item_pallet_set(text, numeric) from public, anon;
grant execute on function public.item_pallet_set(text, numeric) to authenticated;
