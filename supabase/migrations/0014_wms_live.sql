-- Fagron -- «live»: το sync -Live (κάθε ~30") ανεβάζει τις νέες κινήσεις και το
-- απόθεμα ΜΟΝΟ των κωδικών που κινήθηκαν· οι σελίδες ακούν το wms_live (realtime).
create table if not exists public.wms_live (
  key text primary key,          -- stock | stock_full | moves
  at timestamptz not null default now(),
  items text[] not null default '{}',
  n int not null default 0
);
alter table public.wms_live enable row level security;
drop policy if exists wms_live_read on public.wms_live;
create policy wms_live_read on public.wms_live for select to authenticated using (true);
grant select on public.wms_live to authenticated;
do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'wms_live') then
    alter publication supabase_realtime add table public.wms_live;
  end if;
end $$;

create or replace function public.wms_signal(p_key text, p_items text[] default '{}', p_n int default 0)
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Απαιτείται σύνδεση'; end if;
  insert into public.wms_live (key, at, items, n) values (p_key, now(), coalesce(p_items, '{}'), coalesce(p_n, 0))
  on conflict (key) do update set at = now(), items = excluded.items, n = excluded.n;
end;
$$;
revoke all on function public.wms_signal(text, text[], int) from public, anon;
grant execute on function public.wms_signal(text, text[], int) to authenticated;

create or replace function public.wms_replace_items(p_items text[], p_stock jsonb)
returns int language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if auth.uid() is null then raise exception 'Απαιτείται σύνδεση'; end if;
  delete from public.wms_stock where item = any (select upper(trim(x)) from unnest(p_items) x);
  insert into public.wms_stock (item, position, lot, serial, area, expiry, qty)
  select upper(trim(s->>'item')),
         coalesce(trim(coalesce(s->>'position', s->>'positions')), ''),
         coalesce(trim(s->>'lot'), ''), coalesce(trim(s->>'serial'), ''),
         max(coalesce(trim(s->>'area'), '')),
         min(nullif(s->>'expiry', '')::date), sum(coalesce(nullif(s->>'qty', '')::numeric, 0))
  from jsonb_array_elements(coalesce(p_stock, '[]')) t(s)
  where coalesce(trim(s->>'item'), '') <> ''
  group by 1, 2, 3, 4
  on conflict (item, position, lot, serial) do update set qty = excluded.qty, expiry = excluded.expiry, area = excluded.area;
  get diagnostics n = row_count;
  return n;
end;
$$;
revoke all on function public.wms_replace_items(text[], jsonb) from public, anon;
grant execute on function public.wms_replace_items(text[], jsonb) to authenticated;

create or replace function public.wms_moves_last_id()
returns bigint language sql stable security definer set search_path = public as $$
  select max(id::bigint) from public.wms_moves where id ~ '^\d+$'
$$;
revoke all on function public.wms_moves_last_id() from public, anon;
grant execute on function public.wms_moves_last_id() to authenticated;
