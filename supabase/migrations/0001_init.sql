-- Fagron -- Πλάνο Αποθήκης (fagron-whs) -- αρχικό schema
-- Τρέξε αυτό ΠΡΩΤΟ στο Supabase Dashboard -> SQL Editor -> New query -> Run,
-- και μετά τρέξε το 0002_seed_positions.sql (γεμίζει τις 799 πραγματικές θέσεις).

create extension if not exists "pgcrypto";

-- ---------- profiles (ρόλοι χρηστών) ----------
-- Ένα profile δημιουργείται αυτόματα για κάθε νέο χρήστη Supabase Auth.
-- Ο ρόλος default είναι 'staff' -- κάνε κάποιον 'admin' χειροκίνητα από το
-- SQL Editor αν χρειαστεί: update public.profiles set role='admin' where email='...';
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  role text not null default 'staff' check (role in ('admin', 'staff')),
  created_at timestamptz not null default now()
);

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email) values (new.id, new.email);
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------- positions ----------
-- Μία γραμμή ανά πραγματική παλετοθέση. Ο κωδικός (code) είναι το φυσικό
-- κλειδί -- π.χ. "E01-01-1-1". Οι θέσεις δημιουργούνται μία φορά από το
-- 0002_seed_positions.sql· η εφαρμογή ενημερώνει μόνο, δεν προσθέτει νέες.
create table if not exists public.positions (
  code text primary key,
  corridor_id text not null,            -- '1'..'12' ή 'special'
  zone text not null default 'ΚΕΝΤΡΙΚΗ ΑΠΟΘΗΚΗ',
  status text not null default 'free' check (status in ('free', 'occupied', 'reserved')),
  product text not null default '',
  qty int not null default 0,
  notes text not null default '',
  slot_date date,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id)
);

create index if not exists positions_corridor_idx on public.positions(corridor_id);
create index if not exists positions_status_idx on public.positions(status);

-- ---------- ιστορικό αλλαγών (audit log) ----------
-- Γεμίζει αυτόματα από τον trigger παρακάτω -- ΟΧΙ από τον κώδικα της
-- εφαρμογής, ώστε καμία αλλαγή (χειροκίνητη, import Excel, κ.λπ.) να μη
-- μπορεί ποτέ να προσπεράσει την καταγραφή.
create table if not exists public.position_history (
  id uuid primary key default gen_random_uuid(),
  code text not null references public.positions(code) on delete cascade,
  changed_at timestamptz not null default now(),
  changed_by uuid references auth.users(id),
  changed_by_email text,
  old_status text, new_status text,
  old_product text, new_product text,
  old_qty int, new_qty int,
  old_notes text, new_notes text
);

create index if not exists position_history_code_idx on public.position_history(code, changed_at desc);

create or replace function public.log_position_change()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if (old.status, old.product, old.qty, old.notes) is distinct from (new.status, new.product, new.qty, new.notes) then
    insert into public.position_history (
      code, changed_by, changed_by_email,
      old_status, new_status, old_product, new_product, old_qty, new_qty, old_notes, new_notes
    ) values (
      new.code, new.updated_by, (select email from auth.users where id = new.updated_by),
      old.status, new.status, old.product, new.product, old.qty, new.qty, old.notes, new.notes
    );
  end if;
  return new;
end;
$$;

drop trigger if exists positions_after_update on public.positions;
create trigger positions_after_update
  after update on public.positions
  for each row execute function public.log_position_change();

-- ---------- Row Level Security ----------
-- Καμία δημόσια πρόσβαση -- χρειάζεται σύνδεση (Supabase Auth) για ΟΤΙΔΗΠΟΤΕ,
-- ανάγνωση συμπεριλαμβανομένης. Λογαριασμούς τους φτιάχνεις εσύ από
-- Authentication -> Users -> Add user (δεν υπάρχει δημόσια εγγραφή).
alter table public.profiles enable row level security;
alter table public.positions enable row level security;
alter table public.position_history enable row level security;

create policy "signed-in users read profiles" on public.profiles
  for select using (auth.role() = 'authenticated');

create policy "signed-in users read positions" on public.positions
  for select using (auth.role() = 'authenticated');

create policy "signed-in users update positions" on public.positions
  for update using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

create policy "signed-in users read history" on public.position_history
  for select using (auth.role() = 'authenticated');

-- ---------- realtime ----------
-- Lets the app (components/board/Board.tsx) subscribe to live position
-- changes, so when one person on the floor updates a position, everyone
-- else's board updates without a refresh.
alter publication supabase_realtime add table public.positions;
