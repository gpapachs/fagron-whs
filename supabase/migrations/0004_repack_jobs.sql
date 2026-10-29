-- Fagron -- Ανασυσκευασία: καταγραφή χρόνου (έναρξη / λήξη) ανά εργασία
-- Τρέξε το στο Supabase -> SQL Editor -> New query -> Run (μετά το 0003).
-- Ασφαλές να ξανατρέξει.
--
-- Κάθε γραμμή = μία εργασία ανασυσκευασίας ενός κωδικού από έναν χρήστη.
--   running   -> πατήθηκε «Έναρξη», ο χρόνος τρέχει (φαίνεται σε όλους)
--   done      -> πατήθηκε «Λήξη» με τεμάχια + συσκευασίες
--   cancelled -> ακυρώθηκε (δεν μετράει στους μέσους όρους)
-- Η διάρκεια = finished_at - started_at· ο μέσος χρόνος ανά συσκευασία
-- υπολογίζεται στην εφαρμογή (σύνολο χρόνου / σύνολο συσκευασιών).

create table if not exists public.repack_jobs (
  id uuid primary key default gen_random_uuid(),
  recipe_id text not null,
  product_code text not null default '',
  description text not null default '',
  status text not null default 'running' check (status in ('running', 'done', 'cancelled')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  units int check (units >= 0),        -- τεμάχια
  packages int check (packages >= 0),  -- συσκευασίες
  notes text not null default '',
  user_id uuid not null default auth.uid() references auth.users(id),
  user_email text,
  created_at timestamptz not null default now(),
  constraint repack_jobs_done_valid check (
    status <> 'done' or (finished_at is not null and finished_at > started_at and coalesce(packages, 0) > 0)
  )
);

create index if not exists repack_jobs_status_idx on public.repack_jobs(status);
create index if not exists repack_jobs_recipe_idx on public.repack_jobs(recipe_id, finished_at desc);
create index if not exists repack_jobs_started_idx on public.repack_jobs(started_at desc);

-- email χρήστη αυτόματα (όχι από τον browser)
create or replace function public.repack_jobs_set_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    new.user_id := auth.uid();
    new.user_email := (select email from auth.users where id = auth.uid());
  else
    new.user_id := old.user_id;          -- ο κάτοχος δεν αλλάζει
    new.user_email := old.user_email;
  end if;
  return new;
end;
$$;

drop trigger if exists repack_jobs_set_user on public.repack_jobs;
create trigger repack_jobs_set_user
  before insert or update on public.repack_jobs
  for each row execute function public.repack_jobs_set_user();

-- ---------- RLS ----------
alter table public.repack_jobs enable row level security;

drop policy if exists "signed-in read repack_jobs" on public.repack_jobs;
create policy "signed-in read repack_jobs" on public.repack_jobs
  for select using (auth.role() = 'authenticated');

drop policy if exists "start own repack_jobs" on public.repack_jobs;
create policy "start own repack_jobs" on public.repack_jobs
  for insert with check (auth.role() = 'authenticated');

-- λήξη / διόρθωση / ακύρωση: ο ίδιος ή διαχειριστής
drop policy if exists "owner or admin update repack_jobs" on public.repack_jobs;
create policy "owner or admin update repack_jobs" on public.repack_jobs
  for update using (user_id = auth.uid() or public.is_admin())
  with check (user_id = auth.uid() or public.is_admin());

-- οριστική διαγραφή: μόνο διαχειριστής
drop policy if exists "admin delete repack_jobs" on public.repack_jobs;
create policy "admin delete repack_jobs" on public.repack_jobs
  for delete using (public.is_admin());

-- ---------- realtime: όλοι βλέπουν αμέσως ποιος δουλεύει τι ----------
do $$ begin
  alter publication supabase_realtime add table public.repack_jobs;
exception when duplicate_object then null; end $$;
