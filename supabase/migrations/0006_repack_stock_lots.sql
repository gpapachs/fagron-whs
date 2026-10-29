-- Fagron -- Ανασυσκευασία: παρτίδα + ημ. λήξης στο απόθεμα
-- Τρέξε το στο Supabase -> SQL Editor -> New query -> Run (μετά το 0005).
-- Ασφαλές να ξανατρέξει. Μετά ανέβασε ξανά το απόθεμα για να γεμίσουν οι παρτίδες.
--
-- Το απόθεμα κρατιέται πλέον ανά είδος + θέση + παρτίδα (δύο παρτίδες στην
-- ίδια θέση = δύο γραμμές), ώστε η λίστα συλλογής να λέει και ποια παρτίδα.

alter table public.repack_stock add column if not exists lot text not null default '';
alter table public.repack_stock add column if not exists expiry date;

alter table public.repack_stock drop constraint if exists repack_stock_pkey;
alter table public.repack_stock add constraint repack_stock_pkey primary key (item, position, lot);

-- stock: [{ position, area, item, description, qty, unit, lot, expiry }]
create or replace function public.repack_replace_stock(stock jsonb, file_name text default '')
returns int language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Απαιτείται σύνδεση'; end if;
  if jsonb_typeof(stock) <> 'array' or jsonb_array_length(stock) = 0 then
    raise exception 'Κενό απόθεμα';
  end if;

  delete from public.repack_stock where true;

  insert into public.repack_stock (position, area, item, description, qty, unit, lot, expiry)
  select s->>'position', max(coalesce(s->>'area', '')), s->>'item', max(coalesce(s->>'description', '')),
         sum((s->>'qty')::numeric), max(coalesce(s->>'unit', '')),
         coalesce(s->>'lot', ''),
         min(case when coalesce(s->>'expiry', '') ~ '^\d{4}-\d{2}-\d{2}' then (s->>'expiry')::date end)
  from jsonb_array_elements(stock) as t(s)
  where coalesce(s->>'item', '') <> '' and coalesce(s->>'position', '') <> ''
  group by s->>'item', s->>'position', coalesce(s->>'lot', '');

  insert into public.repack_uploads (kind, file_name, row_count, uploaded_at, uploaded_by, uploaded_by_email)
  values ('stock', coalesce(file_name, ''), jsonb_array_length(stock), now(), auth.uid(),
          (select email from auth.users where id = auth.uid()))
  on conflict (kind) do update set file_name = excluded.file_name, row_count = excluded.row_count,
    uploaded_at = excluded.uploaded_at, uploaded_by = excluded.uploaded_by,
    uploaded_by_email = excluded.uploaded_by_email;
  return jsonb_array_length(stock);
end;
$$;

revoke all on function public.repack_replace_stock(jsonb, text) from public, anon;
grant execute on function public.repack_replace_stock(jsonb, text) to authenticated;
