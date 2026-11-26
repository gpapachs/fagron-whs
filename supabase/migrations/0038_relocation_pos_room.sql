-- Μεταφορά αποθέματος: θέσεις που ανήκουν σε χώρο με άλλο πρόθεμα (π.χ. 16.01.01.01 -> χώρος 20). Κοινό για όλους.
create table if not exists public.relocation_pos_room (
  code text primary key,
  room text not null,
  added_by text,
  added_at timestamptz not null default now()
);
alter table public.relocation_pos_room enable row level security;
create policy relocation_pos_room_read on public.relocation_pos_room for select to authenticated using (true);
insert into public.relocation_pos_room (code, room, added_by) values ('16.01.01.01', '20', 'αρχική ρύθμιση') on conflict do nothing;

create or replace function public.relocation_pos_room_set(p_room text, p_codes text[])
returns integer language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  if auth.uid() is null then raise exception 'Απαιτείται σύνδεση'; end if;
  if coalesce(trim(p_room), '') = '' then raise exception 'Χωρίς χώρο'; end if;
  delete from public.relocation_pos_room where room = trim(p_room) and not (code = any(coalesce(p_codes, '{}')));
  insert into public.relocation_pos_room (code, room, added_by)
  select distinct trim(c), trim(p_room), coalesce(auth.jwt()->>'email', '') from unnest(coalesce(p_codes, '{}')) c where trim(coalesce(c, '')) <> ''
  on conflict (code) do update set room = excluded.room, added_by = excluded.added_by, added_at = now();
  select count(*) into n from public.relocation_pos_room where room = trim(p_room);
  perform public.relocation_signal();
  return n;
end $$;
revoke all on function public.relocation_pos_room_set(text, text[]) from public, anon;
grant execute on function public.relocation_pos_room_set(text, text[]) to authenticated;
