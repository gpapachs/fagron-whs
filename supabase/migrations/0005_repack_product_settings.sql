-- Fagron -- Ανασυσκευασία: ρυθμίσεις ανά τελικό κωδικό
-- Τρέξε το στο Supabase -> SQL Editor -> New query -> Run (μετά το 0004).
-- Ασφαλές να ξανατρέξει.
--
-- Ξεχωριστός πίνακας (όχι στις προδιαγραφές), ώστε να μη χάνεται όταν
-- ανεβαίνει νέο Excel προδιαγραφών, και να ισχύει για όλες τις εναλλακτικές
-- του ίδιου τελικού κωδικού (π.χ. 71-00-110 και 71-00-110_2).
--   units_per_package -> τεμάχια ανά συσκευασία
--   reserved          -> τεμάχια που χρειάζονται για παραγγελίες σε εκκρεμότητα

create table if not exists public.repack_product_settings (
  product_code text primary key,
  units_per_package int check (units_per_package is null or units_per_package > 0),
  reserved int not null default 0 check (reserved >= 0),
  reserved_note text not null default '',
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  updated_by_email text
);

create or replace function public.repack_settings_stamp()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  new.updated_at := now();
  new.updated_by := auth.uid();
  new.updated_by_email := (select email from auth.users where id = auth.uid());
  return new;
end;
$$;

drop trigger if exists repack_settings_stamp on public.repack_product_settings;
create trigger repack_settings_stamp
  before insert or update on public.repack_product_settings
  for each row execute function public.repack_settings_stamp();

alter table public.repack_product_settings enable row level security;

drop policy if exists "signed-in read repack_product_settings" on public.repack_product_settings;
create policy "signed-in read repack_product_settings" on public.repack_product_settings
  for select using (auth.role() = 'authenticated');

drop policy if exists "signed-in insert repack_product_settings" on public.repack_product_settings;
create policy "signed-in insert repack_product_settings" on public.repack_product_settings
  for insert with check (auth.role() = 'authenticated');

drop policy if exists "signed-in update repack_product_settings" on public.repack_product_settings;
create policy "signed-in update repack_product_settings" on public.repack_product_settings
  for update using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

do $$ begin
  alter publication supabase_realtime add table public.repack_product_settings;
exception when duplicate_object then null; end $$;
