-- Εβδομαδιαία αναφορά μεταφοράς: η βάση καλεί την edge function relocation-report (pg_net) και εκείνη
-- αποθηκεύει την αναφορά στο relocation_report. Την αποστέλλει μέσω Microsoft 365 μια προγραμματισμένη
-- εργασία κάθε Πέμπτη. Το κλειδί (relocation_report_cfg) ορίστηκε κατά την εφαρμογή και ΔΕΝ είναι στο repo.
create extension if not exists pg_net with schema extensions;

create table if not exists public.relocation_report (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  subject text not null,
  html text not null,
  html365 text not null,
  items integer,
  rows integer
);
alter table public.relocation_report enable row level security;
create policy relocation_report_read on public.relocation_report for select to authenticated using (true);

create table if not exists public.relocation_report_cfg (id int primary key default 1 check (id = 1), key text not null);
alter table public.relocation_report_cfg enable row level security;
-- insert into public.relocation_report_cfg (id, key) values (1, '<τυχαίο κλειδί>');

create or replace function public.relocation_report_check(p_key text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.relocation_report_cfg where key = p_key and length(p_key) >= 32);
$$;
revoke all on function public.relocation_report_check(text) from public;
grant execute on function public.relocation_report_check(text) to anon, authenticated, service_role;

create or replace function public.relocation_report_generate()
returns bigint language plpgsql security definer set search_path = public, extensions as $$
declare k text; rid bigint;
begin
  select key into k from public.relocation_report_cfg where id = 1;
  select net.http_post(
    url := 'https://rvxjwjvwpbljmosdgvzf.supabase.co/functions/v1/relocation-report',
    headers := jsonb_build_object('content-type', 'application/json', 'x-report-key', k),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  ) into rid;
  return rid;
end $$;
revoke all on function public.relocation_report_generate() from public, anon, authenticated;
