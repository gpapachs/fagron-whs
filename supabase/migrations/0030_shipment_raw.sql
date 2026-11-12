-- Αποστολές FSSE live: ο συγχρονισμός (PC) διαβάζει το Excel από τον φάκελο OneDrive κάθε φορά που
-- αλλάζει και ανεβάζει τα κελιά όπως είναι (φύλλα -> γραμμές -> κελιά). Η εφαρμογή τα διαβάζει με
-- την ίδια λογική με το «Ανέβασμα Excel» (lib/shipments.ts) — μία πηγή κανόνων.
create table if not exists public.shipment_raw (
  id integer primary key default 1 check (id = 1),
  file_name text,
  file_mtime timestamptz,
  sheets jsonb not null,
  bytes integer,
  uploaded_by text,
  uploaded_at timestamptz not null default now()
);
alter table public.shipment_raw enable row level security;
create policy shipment_raw_read on public.shipment_raw for select to authenticated using (true);

create or replace function public.shipments_raw_put(p_sheets jsonb, p_file text, p_mtime timestamptz, p_bytes integer default null)
returns integer
language plpgsql security definer set search_path = public
as $$
declare n integer;
begin
  if auth.uid() is null then raise exception 'Απαιτείται σύνδεση'; end if;
  if jsonb_typeof(p_sheets) <> 'array' or jsonb_array_length(p_sheets) = 0 then raise exception 'Κενό αρχείο'; end if;
  n := jsonb_array_length(p_sheets);
  insert into public.shipment_raw (id, file_name, file_mtime, sheets, bytes, uploaded_by, uploaded_at)
  values (1, p_file, p_mtime, p_sheets, p_bytes, coalesce(auth.jwt()->>'email', ''), now())
  on conflict (id) do update set file_name = excluded.file_name, file_mtime = excluded.file_mtime, sheets = excluded.sheets,
    bytes = excluded.bytes, uploaded_by = excluded.uploaded_by, uploaded_at = now();
  insert into public.wms_live (key, at, items, n) values ('shipments', now(), '{}', n)
  on conflict (key) do update set at = now(), items = excluded.items, n = excluded.n;
  return n;
end $$;
revoke all on function public.shipments_raw_put(jsonb, text, timestamptz, integer) from public, anon;
grant execute on function public.shipments_raw_put(jsonb, text, timestamptz, integer) to authenticated;

-- τελευταία αλλαγή αρχείου που έχει ανέβει (για να μην ξαναστέλνει το ίδιο μετά από επανεκκίνηση)
create or replace function public.shipments_raw_mtime()
returns timestamptz language sql stable security definer set search_path = public
as $$ select file_mtime from public.shipment_raw where id = 1 $$;
revoke all on function public.shipments_raw_mtime() from public, anon;
grant execute on function public.shipments_raw_mtime() to authenticated;
