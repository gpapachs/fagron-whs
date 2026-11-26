-- Η χώρα / Ελλάδα-εξωτερικό υπολογίζεται στην εφαρμογή (lib/partnerCountry.ts) — στη βάση ήταν πολύ αργό
-- (~80 regex ανά γραμμή). Η όψη δίνει τα στοιχεία + τη χειροκίνητη διόρθωση χώρας.
drop view if exists public.wms_partners_v;
drop function if exists public.country_from_text(text);
create view public.wms_partners_v with (security_invoker = true) as
select w.id, w.code, w.name, w.is_customer, w.is_supplier, w.active, w.vat, w.vat_eu, w.address, w.city, w.zip, w.phone, w.phone2,
  w.email, w.contact, w.erp_code, w.upd_at, w.synced_at, c.country as manual_country
from public.wms_partners w left join public.wms_partner_country c on c.id = w.id;
grant select on public.wms_partners_v to authenticated;
