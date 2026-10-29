-- Fagron -- Ανασυσκευασία: δεσμευμένα από Excel (εκκρεμείς παραγγελίες)
-- Τρέξε το στο Supabase -> SQL Editor -> New query -> Run (μετά το 0005).
-- Ασφαλές να ξανατρέξει.
--
-- Κάθε ανέβασμα ΑΝΤΙΚΑΘΙΣΤΑ τα δεσμευμένα (το αρχείο εκκρεμοτήτων είναι η
-- τρέχουσα εικόνα): μηδενίζονται όλα και μπαίνουν όσα έχει το αρχείο, σε μία
-- συναλλαγή. Τα «τμχ ανά συσκευασία» δεν πειράζονται.

-- νέο είδος ανεβάσματος στο ιστορικό
alter table public.repack_uploads drop constraint if exists repack_uploads_kind_check;
alter table public.repack_uploads add constraint repack_uploads_kind_check
  check (kind in ('recipes', 'stock', 'reserved'));

-- items: [{ code, qty, orders }]
create or replace function public.repack_replace_reserved(items jsonb, file_name text default '')
returns int language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Απαιτείται σύνδεση'; end if;
  if jsonb_typeof(items) <> 'array' then raise exception 'Λάθος μορφή δεσμευμένων'; end if;

  update public.repack_product_settings
     set reserved = 0, reserved_note = ''
   where reserved <> 0 or reserved_note <> '';

  insert into public.repack_product_settings (product_code, reserved, reserved_note)
  select upper(trim(i->>'code')),
         greatest(0, round((i->>'qty')::numeric))::int,
         case when coalesce((i->>'orders')::int, 0) > 1 then (i->>'orders') || ' παραγγελίες'
              when coalesce((i->>'orders')::int, 0) = 1 then '1 παραγγελία' else '' end
  from jsonb_array_elements(items) as t(i)
  where coalesce(trim(i->>'code'), '') <> ''
  on conflict (product_code) do update
    set reserved = excluded.reserved, reserved_note = excluded.reserved_note;

  insert into public.repack_uploads (kind, file_name, row_count, uploaded_at, uploaded_by, uploaded_by_email)
  values ('reserved', coalesce(file_name, ''), jsonb_array_length(items), now(), auth.uid(),
          (select email from auth.users where id = auth.uid()))
  on conflict (kind) do update set file_name = excluded.file_name, row_count = excluded.row_count,
    uploaded_at = excluded.uploaded_at, uploaded_by = excluded.uploaded_by,
    uploaded_by_email = excluded.uploaded_by_email;
  return jsonb_array_length(items);
end;
$$;

revoke all on function public.repack_replace_reserved(jsonb, text) from public, anon;
grant execute on function public.repack_replace_reserved(jsonb, text) to authenticated;
