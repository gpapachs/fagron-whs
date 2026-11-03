-- Fagron -- απόθεμα: χωρίς παρτίδα = χωρίς λήξη (το WMS βάζει τυχαίες ημερομηνίες,
-- π.χ. παραλαβής) + view με περιγραφή για γρήγορο φόρτωμα της σελίδας «Απόθεμα».
update public.wms_stock set expiry = null where lot = '' and expiry is not null;
update public.repack_stock set expiry = null where coalesce(lot,'') = '' and expiry is not null;
create or replace view public.wms_stock_v with (security_invoker = true) as
  select s.item, s.position, s.area, s.lot, s.serial, case when s.lot = '' then null else s.expiry end as expiry, s.qty,
         coalesce(i.description, '') as description
  from public.wms_stock s left join public.wms_items i on i.code = s.item;
grant select on public.wms_stock_v to authenticated;
