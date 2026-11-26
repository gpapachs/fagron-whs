-- Logistics: (1) γύρος τιμών με τιμή-στόχο και προθεσμία, (2) έγγραφα ανά αίτημα (τιμολόγια, MSDS, CMR, manifest…)
-- σε ιδιωτικό Storage με ορατότητα προς τη μεταφορική, (3) συνημμένα στα email του outbox.

-- ------------------------------------------------------------------ γύρος τιμών
alter table public.rfqs
  add column if not exists round_no integer not null default 0,
  add column if not exists round_target numeric,
  add column if not exists round_currency text,
  add column if not exists round_pct numeric,
  add column if not exists round_deadline timestamptz;
alter table public.rfq_invites add column if not exists round_no integer not null default 0;
alter table public.quotes
  add column if not exists first_price numeric,      -- αρχική τιμή, όταν η μεταφορική την αναθεώρησε
  add column if not exists revised_at timestamptz,
  add column if not exists round_no integer not null default 0;

-- ------------------------------------------------------------------ έγγραφα
create table if not exists public.rfq_docs (
  id uuid primary key default gen_random_uuid(),
  rfq_id uuid not null references public.rfqs(id) on delete cascade,
  kind text not null default 'other' check (kind in ('invoice', 'msds', 'cmr', 'packing', 'coa', 'manifest', 'other')),
  name text not null,
  path text not null unique,            -- στο bucket «logistics»
  size bigint,
  mime text,
  visible text not null default 'no' check (visible in ('no', 'all', 'winner')),  -- ορατό στη μεταφορική
  notes text,
  created_at timestamptz not null default now(),
  created_by text
);
create index if not exists rfq_docs_rfq on public.rfq_docs (rfq_id);
alter table public.rfq_docs enable row level security;
drop policy if exists rfq_docs_all on public.rfq_docs;
create policy rfq_docs_all on public.rfq_docs for all to authenticated using (true) with check (true);
drop trigger if exists rfq_docs_signal on public.rfq_docs;
create trigger rfq_docs_signal after insert or update or delete on public.rfq_docs for each statement execute function public.logistics_signal();

alter table public.mail_outbox add column if not exists attachments jsonb not null default '[]';  -- [{path, name}] από το bucket «logistics»

insert into storage.buckets (id, name, public, file_size_limit)
values ('logistics', 'logistics', false, 52428800)
on conflict (id) do nothing;
drop policy if exists logistics_read on storage.objects;
drop policy if exists logistics_insert on storage.objects;
drop policy if exists logistics_update on storage.objects;
drop policy if exists logistics_delete on storage.objects;
create policy logistics_read on storage.objects for select to authenticated using (bucket_id = 'logistics');
create policy logistics_insert on storage.objects for insert to authenticated with check (bucket_id = 'logistics');
create policy logistics_update on storage.objects for update to authenticated using (bucket_id = 'logistics');
create policy logistics_delete on storage.objects for delete to authenticated using (bucket_id = 'logistics');

-- ------------------------------------------------------------------ δημόσια φόρμα: γύρος + ορατά έγγραφα
create or replace function public.rfq_public_get(p_token text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare i public.rfq_invites; r public.rfqs; c public.carriers; q public.quotes; closed boolean; won boolean; in_round boolean;
begin
  select * into i from public.rfq_invites where token = p_token;
  if not found or length(coalesce(p_token, '')) < 20 then return jsonb_build_object('error', 'not_found'); end if;
  select * into r from public.rfqs where id = i.rfq_id;
  select * into c from public.carriers where id = i.carrier_id;
  select * into q from public.quotes where rfq_id = i.rfq_id and carrier_id = i.carrier_id;
  if i.opened_at is null then
    update public.rfq_invites set opened_at = now() where id = i.id;
    insert into public.rfq_events (rfq_id, by, text) values (r.id, c.name, 'Η μεταφορική άνοιξε το αίτημα');
  end if;
  won := r.awarded_quote is not null and r.awarded_quote = q.id;
  in_round := r.round_no > 0 and i.round_no = r.round_no and r.round_deadline > now() and r.status in ('sent', 'quoted');
  closed := r.status in ('awarded', 'in_transit', 'delivered', 'cancelled')
    or (not in_round and r.quote_deadline is not null and r.quote_deadline < now())
    or (not in_round and i.round_no > 0 and i.round_no = r.round_no and r.round_deadline <= now());
  return jsonb_build_object(
    'carrier', c.name,
    'closed', closed,
    'won', won,
    'round', case when in_round then jsonb_build_object('no', r.round_no, 'target', r.round_target, 'currency', coalesce(r.round_currency, 'EUR'), 'deadline', r.round_deadline) end,
    'rfq', jsonb_build_object(
      'ref', r.ref, 'direction', r.direction, 'mode', r.mode,
      'from_company', r.from_company, 'from_address', r.from_address, 'from_city', r.from_city, 'from_zip', r.from_zip, 'from_country', r.from_country,
      'to_company', r.to_company, 'to_address', r.to_address, 'to_city', r.to_city, 'to_zip', r.to_zip, 'to_country', r.to_country,
      'pickup_date', r.pickup_date, 'delivery_by', r.delivery_by, 'quote_deadline', r.quote_deadline, 'incoterm', r.incoterm,
      'goods', r.goods, 'pallets', r.pallets, 'packages', r.packages, 'weight_kg', r.weight_kg, 'volume_m3', r.volume_m3,
      'ldm', r.ldm, 'dims', r.dims, 'stackable', r.stackable, 'adr', r.adr, 'adr_info', r.adr_info, 'temp', r.temp, 'notes', r.notes),
    'quote', case when q.id is null then null else jsonb_build_object(
      'price', q.price, 'first_price', q.first_price, 'currency', q.currency, 'transit_days', q.transit_days, 'pickup_date', q.pickup_date,
      'delivery_date', q.delivery_date, 'valid_until', q.valid_until, 'includes', q.includes, 'notes', q.notes, 'contact', q.contact, 'at', q.created_at) end,
    'docs', coalesce((select jsonb_agg(jsonb_build_object('id', d.id, 'kind', d.kind, 'name', d.name, 'size', d.size) order by d.created_at)
                      from public.rfq_docs d where d.rfq_id = r.id and (d.visible = 'all' or (d.visible = 'winner' and won))), '[]'),
    'declined', i.declined);
end $$;

create or replace function public.rfq_public_submit(p_token text, p_quote jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare i public.rfq_invites; r public.rfqs; c public.carriers; old public.quotes; price numeric; decline boolean; in_round boolean; cur text;
begin
  select * into i from public.rfq_invites where token = p_token;
  if not found or length(coalesce(p_token, '')) < 20 then raise exception 'Το αίτημα δεν βρέθηκε'; end if;
  select * into r from public.rfqs where id = i.rfq_id;
  select * into c from public.carriers where id = i.carrier_id;
  select * into old from public.quotes where rfq_id = r.id and carrier_id = c.id;
  in_round := r.round_no > 0 and i.round_no = r.round_no and r.round_deadline > now() and r.status in ('sent', 'quoted');
  if r.status in ('awarded', 'in_transit', 'delivered', 'cancelled')
     or (not in_round and r.quote_deadline is not null and r.quote_deadline < now())
     or (not in_round and i.round_no > 0 and i.round_no = r.round_no and r.round_deadline <= now()) then
    raise exception 'Το αίτημα έχει κλείσει';
  end if;
  decline := coalesce((p_quote->>'decline')::boolean, false);
  if decline then
    if in_round and old.id is not null then
      -- στον γύρο τιμών: «δεν μπορώ να κατέβω» = ισχύει η προηγούμενη προσφορά
      insert into public.rfq_events (rfq_id, by, text) values (r.id, c.name, format('Γύρος %s: κρατά την τιμή %s %s', r.round_no, old.price, old.currency) || coalesce(' — ' || nullif(p_quote->>'notes', ''), ''));
      return jsonb_build_object('ok', true);
    end if;
    update public.rfq_invites set declined = true, responded_at = now() where id = i.id;
    delete from public.quotes where rfq_id = r.id and carrier_id = c.id;
    insert into public.rfq_events (rfq_id, by, text) values (r.id, c.name, 'Η μεταφορική δεν δίνει προσφορά' || coalesce(': ' || nullif(p_quote->>'notes', ''), ''));
    return jsonb_build_object('ok', true);
  end if;
  price := nullif(p_quote->>'price', '')::numeric;
  if price is null or price <= 0 then raise exception 'Συμπληρώστε τιμή'; end if;
  cur := coalesce(nullif(p_quote->>'currency', ''), 'EUR');
  insert into public.quotes (rfq_id, carrier_id, price, currency, transit_days, pickup_date, delivery_date, valid_until, includes, notes, contact, source, created_by, round_no, revised_at)
  values (r.id, c.id, price, cur, nullif(p_quote->>'transit_days', '')::numeric,
          nullif(p_quote->>'pickup_date', '')::date, nullif(p_quote->>'delivery_date', '')::date, nullif(p_quote->>'valid_until', '')::date,
          left(p_quote->>'includes', 500), left(p_quote->>'notes', 2000), left(p_quote->>'contact', 200), 'form', c.name,
          case when in_round then r.round_no else 0 end, case when in_round then now() end)
  on conflict (rfq_id, carrier_id) do update set
    first_price = case when public.quotes.price <> excluded.price then coalesce(public.quotes.first_price, public.quotes.price) else public.quotes.first_price end,
    price = excluded.price, currency = excluded.currency, transit_days = excluded.transit_days,
    pickup_date = excluded.pickup_date, delivery_date = excluded.delivery_date, valid_until = excluded.valid_until, includes = excluded.includes,
    notes = excluded.notes, contact = excluded.contact, source = 'form',
    round_no = case when in_round then r.round_no else public.quotes.round_no end,
    revised_at = case when in_round or public.quotes.price <> excluded.price then now() else public.quotes.revised_at end,
    created_at = case when in_round then public.quotes.created_at else now() end;
  update public.rfq_invites set responded_at = now(), declined = false where id = i.id;
  if r.status in ('draft', 'sent') then update public.rfqs set status = 'quoted' where id = r.id; end if;
  insert into public.rfq_events (rfq_id, by, text) values (r.id, c.name,
    case when in_round then format('Γύρος %s: νέα τιμή %s %s', r.round_no, price, cur) || case when old.id is not null then format(' (ήταν %s)', old.price) else '' end
         else format('Προσφορά %s %s', price, cur) end);
  return jsonb_build_object('ok', true);
end $$;

revoke all on function public.rfq_public_get(text) from public;
revoke all on function public.rfq_public_submit(text, jsonb) from public;
grant execute on function public.rfq_public_get(text) to anon, authenticated;
grant execute on function public.rfq_public_submit(text, jsonb) to anon, authenticated;
