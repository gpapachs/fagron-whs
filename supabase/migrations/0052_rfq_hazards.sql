-- Λίστα επικίνδυνων ειδών ανά αίτημα (κωδικός, όνομα, CAS, UN, κλάση, PG, ποσότητα, βάρος, MSDS + εναλλακτικές από το fagron.com).
-- Χωριστός πίνακας (χωρίς σήμα ζωντανής ενημέρωσης), ώστε η επεξεργασία να μη ξαναφορτώνει την οθόνη.
create table if not exists public.rfq_hazards (
  rfq_id uuid primary key references public.rfqs(id) on delete cascade,
  items jsonb not null default '[]',
  updated_at timestamptz not null default now(),
  updated_by text
);
alter table public.rfq_hazards enable row level security;
drop policy if exists rfq_hazards_all on public.rfq_hazards;
create policy rfq_hazards_all on public.rfq_hazards for all to authenticated using (true) with check (true);
