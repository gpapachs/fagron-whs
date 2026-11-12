-- Αποστολές FSSE: γραμμές από το κοινόχρηστο Excel «FSSE SHIPMENTS» (ένα φύλλο ανά πελάτη).
-- Το Excel διαβάζεται στην εφαρμογή (ή από το sync) και αντικαθιστά όλες τις γραμμές.
create table if not exists public.shipment_lines (
  id bigserial primary key,
  sheet text not null,
  row_no integer,
  customer text,
  ship_date date,
  week integer,
  order_date date,
  doc text,
  po text,
  item text,
  bulk text,
  product text,
  sku text,
  qty_ordered numeric,
  qty_initial numeric,
  qty_confirmed numeric,
  requirements text,
  comments text
);
create index if not exists shipment_lines_item on public.shipment_lines (item);
create table if not exists public.shipment_uploads (
  id bigserial primary key,
  file_name text,
  rows integer,
  sheets text,
  source text,
  uploaded_by text,
  uploaded_at timestamptz not null default now()
);
alter table public.shipment_lines enable row level security;
alter table public.shipment_uploads enable row level security;
create policy shipment_lines_read on public.shipment_lines for select to authenticated using (true);
create policy shipment_uploads_read on public.shipment_uploads for select to authenticated using (true);

create or replace function public.shipments_replace(p_rows jsonb, p_file text, p_source text)
returns integer
language plpgsql security definer set search_path = public
as $$
declare n integer;
begin
  if auth.uid() is null then raise exception 'Απαιτείται σύνδεση'; end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then raise exception 'Κενό αρχείο'; end if;
  delete from public.shipment_lines where true;
  insert into public.shipment_lines (sheet, row_no, customer, ship_date, week, order_date, doc, po, item, bulk, product, sku,
                                     qty_ordered, qty_initial, qty_confirmed, requirements, comments)
  select r->>'sheet', (r->>'row_no')::int, r->>'customer', nullif(r->>'ship_date', '')::date, nullif(r->>'week', '')::int,
         nullif(r->>'order_date', '')::date, r->>'doc', r->>'po', upper(r->>'item'), nullif(upper(r->>'bulk'), ''), r->>'product', r->>'sku',
         nullif(r->>'qty_ordered', '')::numeric, nullif(r->>'qty_initial', '')::numeric, nullif(r->>'qty_confirmed', '')::numeric,
         r->>'requirements', r->>'comments'
  from jsonb_array_elements(p_rows) r;
  get diagnostics n = row_count;
  insert into public.shipment_uploads (file_name, rows, sheets, source, uploaded_by)
  values (p_file, n, (select string_agg(distinct r->>'sheet', ', ') from jsonb_array_elements(p_rows) r), p_source, coalesce(auth.jwt()->>'email', ''));
  insert into public.wms_live (key, at, items, n) values ('shipments', now(), '{}', n)
  on conflict (key) do update set at = now(), items = excluded.items, n = excluded.n;
  return n;
end $$;
revoke all on function public.shipments_replace(jsonb, text, text) from public, anon;
grant execute on function public.shipments_replace(jsonb, text, text) to authenticated;
