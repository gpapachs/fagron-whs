-- Fagron -- σχόλια παραγγελίας (ms_Invoicem.Comments / Comments2) + σύνδεση
-- Παραγγελίες -> πλάνο ανασυσκευασίας (repack_plan_orders, κοινό για όλους, realtime).
alter table public.wms_orders add column if not exists comments text not null default '';
create table if not exists public.repack_plan_orders (
  id uuid primary key default gen_random_uuid(),
  recipe_id text not null,
  product_code text not null,
  qty int not null check (qty > 0),
  list_no text not null default '',
  order_line_id text not null default '',
  customer text not null default '',
  created_by text not null default '',
  created_at timestamptz not null default now(),
  done boolean not null default false,
  done_at timestamptz
);
-- RLS: όλοι οι συνδεδεμένοι διαβάζουν / προσθέτουν / κλείνουν· view wms_orders_v και
-- wms_orders_upsert ξαναφτιάχνονται με τη στήλη comments (βλ. βάση).
