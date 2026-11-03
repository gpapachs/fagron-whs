-- Fagron -- Παραγγελίες: πόλη / ΤΚ / ΑΦΜ πελάτη και Ελλάδα ή εξωτερικό (is_abroad, από το sync)
alter table public.wms_orders add column if not exists customer_city text not null default '';
alter table public.wms_orders add column if not exists customer_zip text not null default '';
alter table public.wms_orders add column if not exists customer_vat text not null default '';
alter table public.wms_orders add column if not exists is_abroad boolean not null default false;
-- view wms_orders_v ξαναφτιάχνεται· wms_orders_upsert με τις νέες στήλες (βλ. βάση)
