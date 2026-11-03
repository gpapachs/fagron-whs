-- Fagron -- καρτέλα «Παραγγελίες»: λίστες πωλήσεων SALEXPORTLS στον ίδιο πίνακα wms_orders
-- (doc_type), με ολοκληρωμένη (isCompleted) και αυστηρή συλλογή (isStrictOrderCollection).
alter table public.wms_orders add column if not exists is_completed boolean not null default false;
alter table public.wms_orders add column if not exists is_strict boolean not null default false;
create index if not exists wms_orders_type_idx on public.wms_orders (doc_type, is_completed, order_date desc);
-- view wms_orders_v ξαναφτιάχνεται (νέες στήλες)· wms_orders_upsert με is_completed / is_strict·
-- wms_orders_last(p_doc_type)· wms_open_lists(p_doc_type) -- βλ. εφαρμοσμένη έκδοση στη βάση.
