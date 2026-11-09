-- Χειροκίνητη ανάθεση παραγγελίας προς συλλογή σε αποθήκη (κεντρική / εξωτερική).
-- Κλειδί: το παραστατικό ERP (doc_no) — κοινό στη λίστα πωλήσεων (SALEXPORTLS) και στις
-- λίστες ελέγχου (SALEXPORTCL), ώστε η ανάθεση από τις «Παραγγελίες» να φαίνεται και στο Pick list.
create table if not exists public.pick_assignments (
  doc_no text primary key,
  site text not null check (site in ('central', 'external')),
  assigned_by text,
  assigned_at timestamptz not null default now()
);
alter table public.pick_assignments enable row level security;
create policy pick_assignments_read on public.pick_assignments for select to authenticated using (true);

create or replace function public.pick_assign(p_docs text[], p_site text)
returns integer
language plpgsql security definer set search_path = public
as $$
declare n integer; who text;
begin
  if auth.uid() is null then raise exception 'Απαιτείται σύνδεση'; end if;
  who := coalesce(auth.jwt()->>'email', '');
  if p_site is null or p_site = '' then
    delete from public.pick_assignments where doc_no = any(p_docs);
  else
    if p_site not in ('central', 'external') then raise exception 'Άγνωστη αποθήκη %', p_site; end if;
    insert into public.pick_assignments (doc_no, site, assigned_by, assigned_at)
    select d, p_site, who, now() from unnest(p_docs) d where coalesce(d, '') <> ''
    on conflict (doc_no) do update set site = excluded.site, assigned_by = excluded.assigned_by, assigned_at = now();
  end if;
  get diagnostics n = row_count;
  insert into public.wms_live (key, at, items, n) values ('orders', now(), p_docs, n)
  on conflict (key) do update set at = now(), items = excluded.items, n = excluded.n;
  return n;
end $$;
revoke all on function public.pick_assign(text[], text) from public, anon;
grant execute on function public.pick_assign(text[], text) to authenticated;
