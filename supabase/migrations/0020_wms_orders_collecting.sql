-- Fagron -- Παραγγελίες: «σε συλλογή» (ms_Invoicem.isNowCollecting) + RPC για live ενημέρωση
alter table public.wms_orders add column if not exists is_collecting boolean not null default false;
-- view wms_orders_v / wms_orders_upsert ξαναφτιάχνονται (is_collecting)·
-- wms_orders_set_collecting(p_doc_type, p_ids, p_users): οι p_ids true, οι άλλες false (βλ. βάση)
