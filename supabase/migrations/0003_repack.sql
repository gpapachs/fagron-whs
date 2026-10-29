-- Fagron -- Ανασυσκευασία (σελίδα /repack)
-- Τρέξε το στο Supabase Dashboard -> SQL Editor -> New query -> Run,
-- ΜΕΤΑ τα 0001 και 0002. Μπορεί να ξανατρέξει χωρίς πρόβλημα.
--
-- Δύο σύνολα δεδομένων, που το καθένα αντικαθίσταται ολόκληρο σε κάθε
-- ανέβασμα Excel (μέσω των συναρτήσεων παρακάτω, σε μία συναλλαγή -- αν κάτι
-- αποτύχει μένουν τα προηγούμενα δεδομένα ανέπαφα):
--   * προδιαγραφές ανασυσκευασίας (τελικός κωδικός -> συστατικά)  -- μόνο admin
--   * τελευταίο απόθεμα συστατικών ανά θέση                       -- κάθε συνδεδεμένος

-- ---------- βοηθητική: είναι ο τρέχων χρήστης admin; ----------
create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'admin');
$$;

-- ---------- προδιαγραφές ----------
create table if not exists public.repack_recipes (
  id text primary key,                   -- κλειδί προδιαγραφής, π.χ. '71-00-110_2'
  product_code text not null,            -- κωδικός τελικού, π.χ. '71-00-110'
  description text not null default '',
  sort int not null default 0            -- σειρά όπως στο Excel
);

create table if not exists public.repack_components (
  recipe_id text not null references public.repack_recipes(id) on delete cascade,
  code text not null,
  description text not null default '',
  qty numeric not null check (qty > 0),  -- ανά 1 τεμάχιο τελικού
  unit text not null default '',
  sort int not null default 0,
  primary key (recipe_id, code)
);
create index if not exists repack_components_code_idx on public.repack_components(code);

-- ---------- απόθεμα (τελευταίο ανέβασμα) ----------
create table if not exists public.repack_stock (
  position text not null,
  area text not null default '',
  item text not null,
  description text not null default '',
  qty numeric not null,
  unit text not null default '',
  primary key (item, position)
);

-- Ποιος ανέβασε τι και πότε (μία γραμμή ανά σύνολο δεδομένων)
create table if not exists public.repack_uploads (
  kind text primary key check (kind in ('recipes', 'stock')),
  file_name text not null default '',
  row_count int not null default 0,
  uploaded_at timestamptz not null default now(),
  uploaded_by uuid references auth.users(id),
  uploaded_by_email text
);

-- ---------- RLS: ανάγνωση για συνδεδεμένους, εγγραφή μόνο μέσω συναρτήσεων ----------
alter table public.repack_recipes enable row level security;
alter table public.repack_components enable row level security;
alter table public.repack_stock enable row level security;
alter table public.repack_uploads enable row level security;

drop policy if exists "signed-in read repack_recipes" on public.repack_recipes;
create policy "signed-in read repack_recipes" on public.repack_recipes
  for select using (auth.role() = 'authenticated');
drop policy if exists "signed-in read repack_components" on public.repack_components;
create policy "signed-in read repack_components" on public.repack_components
  for select using (auth.role() = 'authenticated');
drop policy if exists "signed-in read repack_stock" on public.repack_stock;
create policy "signed-in read repack_stock" on public.repack_stock
  for select using (auth.role() = 'authenticated');
drop policy if exists "signed-in read repack_uploads" on public.repack_uploads;
create policy "signed-in read repack_uploads" on public.repack_uploads
  for select using (auth.role() = 'authenticated');
-- Δεν υπάρχουν policies insert/update/delete: οι πίνακες αλλάζουν μόνο από
-- τις security-definer συναρτήσεις παρακάτω, που ελέγχουν τα δικαιώματα.

-- ---------- αντικατάσταση προδιαγραφών (μόνο admin) ----------
-- recipes: [{ id, product_code, description, components: [{ code, description, qty, unit }] }]
create or replace function public.repack_replace_recipes(recipes jsonb, file_name text default '')
returns int language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Απαιτείται σύνδεση'; end if;
  if not public.is_admin() then
    raise exception 'Μόνο διαχειριστής μπορεί να αλλάξει τις προδιαγραφές';
  end if;
  if jsonb_typeof(recipes) <> 'array' or jsonb_array_length(recipes) = 0 then
    raise exception 'Κενή λίστα προδιαγραφών';
  end if;

  delete from public.repack_recipes where true;   -- cascade -> components

  insert into public.repack_recipes (id, product_code, description, sort)
  select r->>'id', coalesce(nullif(r->>'product_code', ''), r->>'id'), coalesce(r->>'description', ''), ord::int
  from jsonb_array_elements(recipes) with ordinality as t(r, ord);

  insert into public.repack_components (recipe_id, code, description, qty, unit, sort)
  select r->>'id', c->>'code', coalesce(c->>'description', ''), (c->>'qty')::numeric,
         coalesce(c->>'unit', ''), cord::int
  from jsonb_array_elements(recipes) as t(r),
       jsonb_array_elements(r->'components') with ordinality as u(c, cord);

  insert into public.repack_uploads (kind, file_name, row_count, uploaded_at, uploaded_by, uploaded_by_email)
  values ('recipes', coalesce(file_name, ''), jsonb_array_length(recipes), now(), auth.uid(),
          (select email from auth.users where id = auth.uid()))
  on conflict (kind) do update set file_name = excluded.file_name, row_count = excluded.row_count,
    uploaded_at = excluded.uploaded_at, uploaded_by = excluded.uploaded_by,
    uploaded_by_email = excluded.uploaded_by_email;
  return jsonb_array_length(recipes);
end;
$$;

-- ---------- αντικατάσταση αποθέματος (κάθε συνδεδεμένος) ----------
-- stock: [{ position, area, item, description, qty, unit }]
create or replace function public.repack_replace_stock(stock jsonb, file_name text default '')
returns int language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Απαιτείται σύνδεση'; end if;
  if jsonb_typeof(stock) <> 'array' or jsonb_array_length(stock) = 0 then
    raise exception 'Κενό απόθεμα';
  end if;

  delete from public.repack_stock where true;

  insert into public.repack_stock (position, area, item, description, qty, unit)
  select s->>'position', max(coalesce(s->>'area', '')), s->>'item', max(coalesce(s->>'description', '')),
         sum((s->>'qty')::numeric), max(coalesce(s->>'unit', ''))
  from jsonb_array_elements(stock) as t(s)
  where coalesce(s->>'item', '') <> '' and coalesce(s->>'position', '') <> ''
  group by s->>'item', s->>'position';

  insert into public.repack_uploads (kind, file_name, row_count, uploaded_at, uploaded_by, uploaded_by_email)
  values ('stock', coalesce(file_name, ''), jsonb_array_length(stock), now(), auth.uid(),
          (select email from auth.users where id = auth.uid()))
  on conflict (kind) do update set file_name = excluded.file_name, row_count = excluded.row_count,
    uploaded_at = excluded.uploaded_at, uploaded_by = excluded.uploaded_by,
    uploaded_by_email = excluded.uploaded_by_email;
  return jsonb_array_length(stock);
end;
$$;

revoke all on function public.repack_replace_recipes(jsonb, text) from public, anon;
revoke all on function public.repack_replace_stock(jsonb, text) from public, anon;
grant execute on function public.repack_replace_recipes(jsonb, text) to authenticated;
grant execute on function public.repack_replace_stock(jsonb, text) to authenticated;
