-- Απενεργοποίηση θέσεων ΜΟΝΟ στην εφαρμογή (κρύβονται από το live «Πλάνο Αποθήκης» και δεν
-- μετράνε στα σύνολα). Το WMS δεν αλλάζει — η πρόσβαση εκεί είναι μόνο ανάγνωση.
create table if not exists public.position_disabled (
  code text primary key,
  disabled_by text,
  disabled_at timestamptz not null default now()
);
alter table public.position_disabled enable row level security;
create policy position_disabled_read on public.position_disabled for select to authenticated using (true);

-- μόνο διαχειριστές· p_disabled = false -> ενεργοποίηση ξανά
create or replace function public.positions_set_disabled(p_codes text[], p_disabled boolean)
returns integer language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  if not public.is_admin() then raise exception 'Μόνο διαχειριστής μπορεί να απενεργοποιήσει θέσεις'; end if;
  if p_disabled then
    insert into public.position_disabled (code, disabled_by, disabled_at)
    select c, coalesce(auth.jwt()->>'email', ''), now() from unnest(p_codes) c where coalesce(c, '') <> ''
    on conflict (code) do nothing;
  else
    delete from public.position_disabled where code = any(p_codes);
  end if;
  get diagnostics n = row_count;
  insert into public.wms_live (key, at, items, n) values ('positions', now(), '{}', n)
  on conflict (key) do update set at = now(), items = excluded.items, n = excluded.n;
  return n;
end $$;
revoke all on function public.positions_set_disabled(text[], boolean) from public, anon;
grant execute on function public.positions_set_disabled(text[], boolean) to authenticated;
