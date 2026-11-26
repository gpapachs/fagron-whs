-- Στοιχεία loading manifest (γραμμές φορτίου, όχημα, οδηγός…) για επανέκδοση
alter table public.rfqs add column if not exists manifest jsonb;
