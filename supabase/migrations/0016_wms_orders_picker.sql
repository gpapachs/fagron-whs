-- Fagron -- Orders: χρήστης που έκανε τη συλλογή (WMS: ms_Invoicem.zprocessedby ή ms_User)
alter table public.wms_orders add column if not exists picker text not null default '';
create index if not exists wms_orders_picker_idx on public.wms_orders (picker);
drop view if exists public.wms_orders_v;
create view public.wms_orders_v with (security_invoker = true) as
  select o.*, coalesce(i.description, '') as description
  from public.wms_orders o left join public.wms_items i on i.code = o.item;
grant select on public.wms_orders_v to authenticated;
-- wms_orders_upsert: ίδιο με το 0015 + στήλη picker (βλ. εφαρμοσμένη έκδοση στη βάση)
