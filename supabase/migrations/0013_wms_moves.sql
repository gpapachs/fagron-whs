-- Fagron -- κινήσεις WMS (σελίδα «Κινήσεις»). Γεμίζει σταδιακά από το sync
-- (movements-query.sql, μόνο νέες κινήσεις κάθε φορά). Η σελίδα ΔΕΝ τις φορτώνει
-- όλες: ρωτά με φίλτρα μόνο όταν πατηθεί «Αναζήτηση».
create extension if not exists pg_trgm with schema extensions;
create table if not exists public.wms_moves (
  id text primary key,            -- μοναδικό id κίνησης στο WMS
  moved_at timestamptz,
  type text not null default '',  -- είδος κίνησης (παραλαβή, μεταφορά, αποστολή…)
  doc text not null default '',   -- παραστατικό / παραγγελία
  item text not null default '',
  lot text not null default '',
  serial text not null default '',
  qty numeric,
  from_pos text not null default '',
  to_pos text not null default '',
  customer text not null default '',
  username text not null default '',
  synced_at timestamptz not null default now()
);
create index if not exists wms_moves_at_idx on public.wms_moves (moved_at desc);
create index if not exists wms_moves_item_idx on public.wms_moves (item, moved_at desc);
create index if not exists wms_moves_lot_idx on public.wms_moves (lot);
create index if not exists wms_moves_serial_idx on public.wms_moves (serial);
create index if not exists wms_moves_from_idx on public.wms_moves (from_pos text_pattern_ops);
create index if not exists wms_moves_to_idx on public.wms_moves (to_pos text_pattern_ops);
create index if not exists wms_moves_customer_trgm on public.wms_moves using gin (customer extensions.gin_trgm_ops);
alter table public.wms_moves enable row level security;
drop policy if exists wms_moves_read on public.wms_moves;
create policy wms_moves_read on public.wms_moves for select to authenticated using (true);
grant select on public.wms_moves to authenticated;

create or replace view public.wms_moves_v with (security_invoker = true) as
  select m.*, coalesce(i.description, '') as description
  from public.wms_moves m left join public.wms_items i on i.code = m.item;
grant select on public.wms_moves_v to authenticated;

create or replace function public.wms_moves_upsert(p_rows jsonb)
returns int language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if auth.uid() is null then raise exception 'Απαιτείται σύνδεση'; end if;
  if jsonb_typeof(p_rows) <> 'array' then raise exception 'Λάθος μορφή'; end if;
  insert into public.wms_moves (id, moved_at, type, doc, item, lot, serial, qty, from_pos, to_pos, customer, username, synced_at)
  select distinct on (trim(r->>'id'))
         trim(r->>'id'), nullif(r->>'moved_at', '')::timestamptz,
         coalesce(trim(r->>'type'), ''), coalesce(trim(r->>'doc'), ''), upper(coalesce(trim(r->>'item'), '')),
         coalesce(trim(r->>'lot'), ''), coalesce(trim(r->>'serial'), ''), nullif(r->>'qty', '')::numeric,
         coalesce(trim(r->>'from_pos'), ''), coalesce(trim(r->>'to_pos'), ''),
         coalesce(trim(r->>'customer'), ''), coalesce(trim(r->>'username'), ''), now()
  from jsonb_array_elements(p_rows) t(r)
  where coalesce(trim(r->>'id'), '') <> ''
  on conflict (id) do update set
    moved_at = excluded.moved_at, type = excluded.type, doc = excluded.doc, item = excluded.item, lot = excluded.lot,
    serial = excluded.serial, qty = excluded.qty, from_pos = excluded.from_pos, to_pos = excluded.to_pos,
    customer = excluded.customer, username = excluded.username, synced_at = now();
  get diagnostics n = row_count;
  return n;
end;
$$;
revoke all on function public.wms_moves_upsert(jsonb) from public, anon;
grant execute on function public.wms_moves_upsert(jsonb) to authenticated;

create or replace function public.wms_moves_last()
returns timestamptz language sql stable security definer set search_path = public as $$
  select max(moved_at) from public.wms_moves
$$;
revoke all on function public.wms_moves_last() from public, anon;
grant execute on function public.wms_moves_last() to authenticated;
