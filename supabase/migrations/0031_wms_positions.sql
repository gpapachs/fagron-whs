-- Όλες οι θέσεις του WMS (dbo.ms_Pos), και οι άδειες: κωδικός, περιγραφή (= χώρος/περιοχή) και οι
-- υπόλοιπες στήλες όπως είναι (attrs). Βάση για το live «Πλάνο Αποθήκης».
create table if not exists public.wms_positions (
  code text primary key,
  descr text,
  attrs jsonb not null default '{}'::jsonb,
  synced_at timestamptz not null default now()
);
alter table public.wms_positions enable row level security;
create policy wms_positions_read on public.wms_positions for select to authenticated using (true);

create or replace function public.wms_positions_upload(p_rows jsonb, p_stamp timestamptz)
returns integer language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  if auth.uid() is null then raise exception 'Απαιτείται σύνδεση'; end if;
  insert into public.wms_positions (code, descr, attrs, synced_at)
  select r->>'code', nullif(r->>'descr', ''), coalesce(r->'attrs', '{}'::jsonb), p_stamp
  from jsonb_array_elements(p_rows) r where coalesce(r->>'code', '') <> ''
  on conflict (code) do update set descr = excluded.descr, attrs = excluded.attrs, synced_at = excluded.synced_at;
  get diagnostics n = row_count;
  return n;
end $$;

-- μετά το τελευταίο κομμάτι: σβήνει θέσεις που δεν υπάρχουν πια και ειδοποιεί τις οθόνες
create or replace function public.wms_positions_prune(p_stamp timestamptz)
returns integer language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  if auth.uid() is null then raise exception 'Απαιτείται σύνδεση'; end if;
  delete from public.wms_positions where synced_at <> p_stamp;
  get diagnostics n = row_count;
  insert into public.wms_live (key, at, items, n) values ('positions', now(), '{}', (select count(*) from public.wms_positions))
  on conflict (key) do update set at = now(), items = excluded.items, n = excluded.n;
  return n;
end $$;

revoke all on function public.wms_positions_upload(jsonb, timestamptz) from public, anon;
revoke all on function public.wms_positions_prune(timestamptz) from public, anon;
grant execute on function public.wms_positions_upload(jsonb, timestamptz) to authenticated;
grant execute on function public.wms_positions_prune(timestamptz) to authenticated;
