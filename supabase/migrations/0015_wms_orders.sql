-- Fagron -- σελίδα «Orders»: γραμμές παραστατικών πωλήσεων του WMS (ms_Invoicem /
-- ms_Invoiced, τύπος salexportcl). Γεμίζει από το sync. Η κατάσταση Collected /
-- Non Collected είναι ΧΕΙΡΟΚΙΝΗΤΗ και δεν την πειράζει ποτέ το sync.
create table if not exists public.wms_orders (
  id text primary key,                 -- γραμμή (ms_Invoiced.ID)
  order_id text not null default '',   -- παραστατικό (ms_Invoicem.ID)
  list_no text not null default '',    -- αριθμός λίστας
  doc_type text not null default '',
  doc_no text not null default '',     -- παραστατικό
  erp_code text not null default '',   -- κωδικός ERP
  order_date timestamptz,
  customer text not null default '',
  item text not null default '',
  lot text not null default '',
  sn text not null default '',
  qty numeric,
  init_qty numeric,
  from_pos text not null default '',
  to_pos text not null default '',
  wms_status text not null default '',
  line_no int,
  collected boolean not null default false,
  collected_at timestamptz,
  collected_by text not null default '',
  synced_at timestamptz not null default now()
);
create index if not exists wms_orders_date_idx on public.wms_orders (order_date desc);
create index if not exists wms_orders_list_idx on public.wms_orders (list_no);
create index if not exists wms_orders_item_idx on public.wms_orders (item);
create index if not exists wms_orders_lot_idx on public.wms_orders (lot);
create index if not exists wms_orders_sn_idx on public.wms_orders (sn);
create index if not exists wms_orders_doc_idx on public.wms_orders (doc_no);
create index if not exists wms_orders_erp_idx on public.wms_orders (erp_code);
create index if not exists wms_orders_customer_trgm on public.wms_orders using gin (customer extensions.gin_trgm_ops);
alter table public.wms_orders enable row level security;
drop policy if exists wms_orders_read on public.wms_orders;
create policy wms_orders_read on public.wms_orders for select to authenticated using (true);
grant select on public.wms_orders to authenticated;

create or replace view public.wms_orders_v with (security_invoker = true) as
  select o.*, coalesce(i.description, '') as description
  from public.wms_orders o left join public.wms_items i on i.code = o.item;
grant select on public.wms_orders_v to authenticated;

-- sync: ΔΕΝ αγγίζει collected / collected_at / collected_by
create or replace function public.wms_orders_upsert(p_rows jsonb)
returns int language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if auth.uid() is null then raise exception 'Απαιτείται σύνδεση'; end if;
  if jsonb_typeof(p_rows) <> 'array' then raise exception 'Λάθος μορφή'; end if;
  insert into public.wms_orders (id, order_id, list_no, doc_type, doc_no, erp_code, order_date, customer, item, lot, sn,
                                 qty, init_qty, from_pos, to_pos, wms_status, line_no, synced_at)
  select distinct on (trim(r->>'id'))
         trim(r->>'id'), coalesce(trim(r->>'order_id'), ''), coalesce(trim(r->>'list_no'), ''), coalesce(trim(r->>'doc_type'), ''),
         coalesce(trim(r->>'doc_no'), ''), coalesce(trim(r->>'erp_code'), ''), nullif(r->>'order_date', '')::timestamptz,
         coalesce(trim(r->>'customer'), ''), upper(coalesce(trim(r->>'item'), '')), coalesce(trim(r->>'lot'), ''),
         coalesce(trim(r->>'sn'), ''), nullif(r->>'qty', '')::numeric, nullif(r->>'init_qty', '')::numeric,
         coalesce(trim(r->>'from_pos'), ''), coalesce(trim(r->>'to_pos'), ''), coalesce(trim(r->>'wms_status'), ''),
         nullif(r->>'line_no', '')::numeric::int, now()
  from jsonb_array_elements(p_rows) t(r)
  where coalesce(trim(r->>'id'), '') <> ''
  on conflict (id) do update set
    order_id = excluded.order_id, list_no = excluded.list_no, doc_type = excluded.doc_type, doc_no = excluded.doc_no,
    erp_code = excluded.erp_code, order_date = excluded.order_date, customer = excluded.customer, item = excluded.item,
    lot = excluded.lot, sn = excluded.sn, qty = excluded.qty, init_qty = excluded.init_qty, from_pos = excluded.from_pos,
    to_pos = excluded.to_pos, wms_status = excluded.wms_status, line_no = excluded.line_no, synced_at = now();
  get diagnostics n = row_count;
  return n;
end;
$$;
revoke all on function public.wms_orders_upsert(jsonb) from public, anon;
grant execute on function public.wms_orders_upsert(jsonb) to authenticated;

-- χρήστης: Collected / Non Collected στις επιλεγμένες γραμμές
create or replace function public.wms_orders_set_collected(p_ids text[], p_value boolean)
returns int language plpgsql security definer set search_path = public as $$
declare n int; who text;
begin
  if auth.uid() is null then raise exception 'Απαιτείται σύνδεση'; end if;
  select coalesce(email, '') into who from auth.users where id = auth.uid();
  update public.wms_orders
     set collected = p_value,
         collected_at = case when p_value then now() end,
         collected_by = case when p_value then coalesce(who, '') else '' end
   where id = any (p_ids) and collected is distinct from p_value;
  get diagnostics n = row_count;
  insert into public.wms_live (key, at, items, n) values ('orders', now(), p_ids, n)
  on conflict (key) do update set at = now(), items = excluded.items, n = excluded.n;
  return n;
end;
$$;
revoke all on function public.wms_orders_set_collected(text[], boolean) from public, anon;
grant execute on function public.wms_orders_set_collected(text[], boolean) to authenticated;

create or replace function public.wms_orders_last()
returns timestamptz language sql stable security definer set search_path = public as $$
  select max(order_date) from public.wms_orders
$$;
revoke all on function public.wms_orders_last() from public, anon;
grant execute on function public.wms_orders_last() to authenticated;
