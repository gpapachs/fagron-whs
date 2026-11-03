-- Fagron -- Ετικέτες για ΟΛΑ τα προϊόντα: κατάλογος κωδικών + απόθεμα WMS ανά
-- παρτίδα/serial (όχι μόνο τα συστατικά της ανασυσκευασίας). Γεμίζει από το sync.
-- Ασφαλές να ξανατρέξει.

create table if not exists public.wms_items (
  code text primary key,
  description text not null default '',
  description_en text not null default '', -- ms_Item.AlterDescr (μόνο αν είναι λατινικά)
  updated_at timestamptz not null default now()
);

create table if not exists public.wms_stock (
  item text not null,
  lot text not null default '',
  serial text not null default '',
  expiry date,
  qty numeric not null default 0,
  positions text not null default '',
  primary key (item, lot, serial)
);

alter table public.wms_items enable row level security;
alter table public.wms_stock enable row level security;
drop policy if exists wms_items_read on public.wms_items;
create policy wms_items_read on public.wms_items for select to authenticated using (true);
drop policy if exists wms_stock_read on public.wms_stock;
create policy wms_stock_read on public.wms_stock for select to authenticated using (true);
grant select on public.wms_items, public.wms_stock to authenticated;

-- Ανέβασμα σε κομμάτια: το πρώτο κομμάτι (p_first) αδειάζει τον πίνακα του αποθέματος.
-- items: [{code, description, description_en}]  stock: [{item, lot, serial, expiry, qty, positions}]
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

  insert into public.wms_stock (item, lot, serial, expiry, qty, positions)
  select upper(trim(s->>'item')), coalesce(trim(s->>'lot'), ''), coalesce(trim(s->>'serial'), ''),
         nullif(s->>'expiry', '')::date, coalesce(nullif(s->>'qty', '')::numeric, 0), coalesce(s->>'positions', '')
  from jsonb_array_elements(coalesce(p_stock, '[]')) t(s)
  where coalesce(trim(s->>'item'), '') <> ''
  on conflict (item, lot, serial) do update
    set qty = wms_stock.qty + excluded.qty,
        expiry = coalesce(wms_stock.expiry, excluded.expiry),
        positions = case when wms_stock.positions = '' then excluded.positions
                         when excluded.positions = '' then wms_stock.positions
                         else wms_stock.positions || ', ' || excluded.positions end;
  get diagnostics n = row_count;
  return n;
end;
$$;

revoke all on function public.wms_upload(jsonb, jsonb, boolean) from public, anon;
grant execute on function public.wms_upload(jsonb, jsonb, boolean) to authenticated;
