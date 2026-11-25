-- Μεταφορά αποθέματος: κοινό Pick list για όλους τους χρήστες + θέσεις από τις οποίες δεν
-- παίρνουμε ποτέ απόθεμα. Μία γραμμή ανά κωδικό: τι τσεκαρίστηκε, συνολική ή ανά παρτίδα ποσότητα.
create table if not exists public.relocation_pick (
  item text primary key,
  keys text[] not null default '{}',      -- κλειδιά γραμμών (κωδικός|θέση|παρτίδα|λήξη) ή «κωδικός|*»
  manual numeric,                          -- συνολικά τεμάχια να φύγουν (αντί της πρότασης)
  lot_qty jsonb not null default '{}',     -- τεμάχια ανά παρτίδα/θέση
  updated_by text,
  updated_at timestamptz not null default now()
);
alter table public.relocation_pick enable row level security;
create policy relocation_pick_read on public.relocation_pick for select to authenticated using (true);

create table if not exists public.relocation_skip_pos (
  code text primary key,
  added_by text,
  added_at timestamptz not null default now()
);
alter table public.relocation_skip_pos enable row level security;
create policy relocation_skip_pos_read on public.relocation_skip_pos for select to authenticated using (true);
insert into public.relocation_skip_pos (code, added_by) values ('06.01.01.02', 'αρχική ρύθμιση') on conflict do nothing;

create or replace function public.relocation_signal() returns void language sql security definer set search_path = public as $$
  insert into public.wms_live (key, at, items, n) values ('relocation_pick', now(), '{}', 0)
  on conflict (key) do update set at = now(), items = excluded.items, n = excluded.n;
$$;
revoke all on function public.relocation_signal() from public, anon, authenticated;

-- p_rows: [{item, keys[], manual, lot_qty}] — γραμμή χωρίς τίποτα = διαγραφή του κωδικού
create or replace function public.relocation_pick_put(p_rows jsonb)
returns integer language plpgsql security definer set search_path = public as $$
declare r jsonb; n integer := 0; k text[]; who text := coalesce(auth.jwt()->>'email', '');
begin
  if auth.uid() is null then raise exception 'Απαιτείται σύνδεση'; end if;
  for r in select * from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) loop
    k := coalesce(array(select jsonb_array_elements_text(r->'keys')), '{}');
    if coalesce(cardinality(k), 0) = 0 and (r->>'manual') is null and coalesce(r->'lot_qty', '{}'::jsonb) = '{}'::jsonb then
      delete from public.relocation_pick where item = r->>'item';
    else
      insert into public.relocation_pick (item, keys, manual, lot_qty, updated_by, updated_at)
      values (r->>'item', k, nullif(r->>'manual', '')::numeric, coalesce(r->'lot_qty', '{}'::jsonb), who, now())
      on conflict (item) do update set keys = excluded.keys, manual = excluded.manual, lot_qty = excluded.lot_qty,
        updated_by = excluded.updated_by, updated_at = now();
    end if;
    n := n + 1;
  end loop;
  perform public.relocation_signal();
  return n;
end $$;

create or replace function public.relocation_pick_clear()
returns integer language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  if auth.uid() is null then raise exception 'Απαιτείται σύνδεση'; end if;
  delete from public.relocation_pick where true;
  get diagnostics n = row_count;
  perform public.relocation_signal();
  return n;
end $$;

create or replace function public.relocation_skip_set(p_codes text[])
returns integer language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  if auth.uid() is null then raise exception 'Απαιτείται σύνδεση'; end if;
  delete from public.relocation_skip_pos where not (code = any(coalesce(p_codes, '{}')));
  insert into public.relocation_skip_pos (code, added_by)
  select distinct trim(c), coalesce(auth.jwt()->>'email', '') from unnest(coalesce(p_codes, '{}')) c where trim(coalesce(c, '')) <> ''
  on conflict do nothing;
  select count(*) into n from public.relocation_skip_pos;
  perform public.relocation_signal();
  return n;
end $$;

revoke all on function public.relocation_pick_put(jsonb) from public, anon;
revoke all on function public.relocation_pick_clear() from public, anon;
revoke all on function public.relocation_skip_set(text[]) from public, anon;
grant execute on function public.relocation_pick_put(jsonb) to authenticated;
grant execute on function public.relocation_pick_clear() to authenticated;
grant execute on function public.relocation_skip_set(text[]) to authenticated;
