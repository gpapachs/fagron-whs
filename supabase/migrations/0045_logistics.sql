-- Logistics: μητρώο μεταφορικών, αιτήματα προσφοράς (εισαγωγές / εξαγωγές), προσφορές, ανάθεση, παρακολούθηση.
-- Οι μεταφορικές απαντούν από δημόσια φόρμα (link με token, χωρίς login) μέσω των rfq_public_* RPC.
-- Τα email φεύγουν από το Outlook του υπολογιστή της αποθήκης (mail_outbox -> sync-stock.ps1).

create table if not exists public.carriers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  emails text[] not null default '{}',
  contact text,
  phone text,
  modes text[] not null default '{}',        -- road / groupage / ftl / air / sea / courier
  countries text[] not null default '{}',    -- χώρες / διαδρομές που καλύπτει (ISO ή ονόματα)
  notes text,
  rating smallint check (rating between 1 and 5),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by text
);

create sequence if not exists public.rfq_seq;

create table if not exists public.rfqs (
  id uuid primary key default gen_random_uuid(),
  ref text not null unique default ('RFQ-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('public.rfq_seq')::text, 4, '0')),
  direction text not null check (direction in ('import', 'export')),
  status text not null default 'draft' check (status in ('draft', 'sent', 'quoted', 'awarded', 'in_transit', 'delivered', 'cancelled')),
  mode text,                                  -- road / groupage / ftl / air / sea / courier
  from_company text, from_address text, from_city text, from_zip text, from_country text,
  to_company text, to_address text, to_city text, to_zip text, to_country text,
  pickup_date date,
  delivery_by date,
  quote_deadline timestamptz,
  incoterm text,
  goods text,
  pallets integer,
  packages integer,
  weight_kg numeric,
  volume_m3 numeric,
  ldm numeric,
  dims text,
  stackable boolean,
  adr boolean not null default false,
  adr_info text,
  temp text,                                  -- π.χ. 15-25°C, 2-8°C
  value_eur numeric,
  customer text,                              -- πελάτης / προμηθευτής
  order_ref text,                             -- αρ. παραγγελίας / PO
  notes text,                                 -- φαίνονται στις μεταφορικές
  internal_notes text,                        -- μόνο εσωτερικά
  awarded_quote uuid,
  carrier_ref text,
  tracking_no text,
  tracking_url text,
  eta date,
  picked_at date,
  delivered_at date,
  final_cost numeric,
  docs text,                                  -- σύνδεσμοι / σημειώσεις εγγράφων (CMR, τιμολόγιο…)
  created_at timestamptz not null default now(),
  created_by text,
  updated_at timestamptz not null default now()
);
create index if not exists rfqs_status on public.rfqs (status);

create table if not exists public.rfq_invites (
  id uuid primary key default gen_random_uuid(),
  rfq_id uuid not null references public.rfqs(id) on delete cascade,
  carrier_id uuid not null references public.carriers(id) on delete cascade,
  token text not null unique default encode(extensions.gen_random_bytes(18), 'hex'),
  emails text[] not null default '{}',
  sent_at timestamptz,
  opened_at timestamptz,
  responded_at timestamptz,
  declined boolean not null default false,
  created_at timestamptz not null default now(),
  unique (rfq_id, carrier_id)
);

create table if not exists public.quotes (
  id uuid primary key default gen_random_uuid(),
  rfq_id uuid not null references public.rfqs(id) on delete cascade,
  carrier_id uuid not null references public.carriers(id) on delete cascade,
  price numeric not null,
  currency text not null default 'EUR',
  transit_days numeric,
  pickup_date date,
  delivery_date date,
  valid_until date,
  includes text,                              -- τι περιλαμβάνει (καύσιμα, διόδια, εκτελωνισμός…)
  notes text,
  contact text,
  source text not null default 'form' check (source in ('form', 'manual', 'email')),
  created_at timestamptz not null default now(),
  created_by text,
  unique (rfq_id, carrier_id)
);

create table if not exists public.rfq_events (
  id bigserial primary key,
  rfq_id uuid not null references public.rfqs(id) on delete cascade,
  at timestamptz not null default now(),
  by text,
  text text not null
);
create index if not exists rfq_events_rfq on public.rfq_events (rfq_id, at);

create table if not exists public.mail_outbox (
  id bigserial primary key,
  to_addrs text[] not null,
  cc_addrs text[] not null default '{}',
  subject text not null,
  html text not null,
  rfq_id uuid references public.rfqs(id) on delete set null,
  status text not null default 'pending' check (status in ('pending', 'sent', 'error', 'cancelled')),
  error text,
  created_at timestamptz not null default now(),
  created_by text,
  sent_at timestamptz
);
create index if not exists mail_outbox_pending on public.mail_outbox (status) where status = 'pending';

-- RLS: όλοι οι συνδεδεμένοι χρήστες (εσωτερική εφαρμογή) διαβάζουν και γράφουν
do $$
declare t text;
begin
  foreach t in array array['carriers', 'rfqs', 'rfq_invites', 'quotes', 'rfq_events', 'mail_outbox'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I on public.%I', t || '_all', t);
    execute format('create policy %I on public.%I for all to authenticated using (true) with check (true)', t || '_all', t);
  end loop;
end $$;
grant usage on sequence public.rfq_seq to authenticated;

-- ζωντανή ενημέρωση των οθονών
create or replace function public.logistics_signal() returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.wms_live (key, at, items, n) values ('logistics', now(), '{}', 0)
  on conflict (key) do update set at = now();
  return null;
end $$;
do $$
declare t text;
begin
  foreach t in array array['carriers', 'rfqs', 'rfq_invites', 'quotes', 'rfq_events', 'mail_outbox'] loop
    execute format('drop trigger if exists %I on public.%I', t || '_signal', t);
    execute format('create trigger %I after insert or update or delete on public.%I for each statement execute function public.logistics_signal()', t || '_signal', t);
  end loop;
end $$;

create or replace function public.rfqs_touch() returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;
drop trigger if exists rfqs_touch on public.rfqs;
create trigger rfqs_touch before update on public.rfqs for each row execute function public.rfqs_touch();

-- ------------------------------------------------------------------ δημόσια φόρμα (μεταφορική, χωρίς login)
create or replace function public.rfq_public_get(p_token text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare i public.rfq_invites; r public.rfqs; c public.carriers; q public.quotes; closed boolean;
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
  closed := r.status in ('awarded', 'in_transit', 'delivered', 'cancelled') or (r.quote_deadline is not null and r.quote_deadline < now());
  return jsonb_build_object(
    'carrier', c.name,
    'closed', closed,
    'won', r.awarded_quote is not null and r.awarded_quote = q.id,
    'rfq', jsonb_build_object(
      'ref', r.ref, 'direction', r.direction, 'mode', r.mode,
      'from_company', r.from_company, 'from_address', r.from_address, 'from_city', r.from_city, 'from_zip', r.from_zip, 'from_country', r.from_country,
      'to_company', r.to_company, 'to_address', r.to_address, 'to_city', r.to_city, 'to_zip', r.to_zip, 'to_country', r.to_country,
      'pickup_date', r.pickup_date, 'delivery_by', r.delivery_by, 'quote_deadline', r.quote_deadline, 'incoterm', r.incoterm,
      'goods', r.goods, 'pallets', r.pallets, 'packages', r.packages, 'weight_kg', r.weight_kg, 'volume_m3', r.volume_m3,
      'ldm', r.ldm, 'dims', r.dims, 'stackable', r.stackable, 'adr', r.adr, 'adr_info', r.adr_info, 'temp', r.temp, 'notes', r.notes),
    'quote', case when q.id is null then null else jsonb_build_object(
      'price', q.price, 'currency', q.currency, 'transit_days', q.transit_days, 'pickup_date', q.pickup_date,
      'delivery_date', q.delivery_date, 'valid_until', q.valid_until, 'includes', q.includes, 'notes', q.notes, 'contact', q.contact, 'at', q.created_at) end,
    'declined', i.declined);
end $$;

create or replace function public.rfq_public_submit(p_token text, p_quote jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare i public.rfq_invites; r public.rfqs; c public.carriers; price numeric; decline boolean;
begin
  select * into i from public.rfq_invites where token = p_token;
  if not found or length(coalesce(p_token, '')) < 20 then raise exception 'Το αίτημα δεν βρέθηκε'; end if;
  select * into r from public.rfqs where id = i.rfq_id;
  select * into c from public.carriers where id = i.carrier_id;
  if r.status in ('awarded', 'in_transit', 'delivered', 'cancelled') or (r.quote_deadline is not null and r.quote_deadline < now()) then
    raise exception 'Το αίτημα έχει κλείσει';
  end if;
  decline := coalesce((p_quote->>'decline')::boolean, false);
  if decline then
    update public.rfq_invites set declined = true, responded_at = now() where id = i.id;
    delete from public.quotes where rfq_id = r.id and carrier_id = c.id;
    insert into public.rfq_events (rfq_id, by, text) values (r.id, c.name, 'Η μεταφορική δεν δίνει προσφορά' || coalesce(': ' || nullif(p_quote->>'notes', ''), ''));
    return jsonb_build_object('ok', true);
  end if;
  price := nullif(p_quote->>'price', '')::numeric;
  if price is null or price <= 0 then raise exception 'Συμπληρώστε τιμή'; end if;
  insert into public.quotes (rfq_id, carrier_id, price, currency, transit_days, pickup_date, delivery_date, valid_until, includes, notes, contact, source, created_by)
  values (r.id, c.id, price, coalesce(nullif(p_quote->>'currency', ''), 'EUR'), nullif(p_quote->>'transit_days', '')::numeric,
          nullif(p_quote->>'pickup_date', '')::date, nullif(p_quote->>'delivery_date', '')::date, nullif(p_quote->>'valid_until', '')::date,
          left(p_quote->>'includes', 500), left(p_quote->>'notes', 2000), left(p_quote->>'contact', 200), 'form', c.name)
  on conflict (rfq_id, carrier_id) do update set price = excluded.price, currency = excluded.currency, transit_days = excluded.transit_days,
    pickup_date = excluded.pickup_date, delivery_date = excluded.delivery_date, valid_until = excluded.valid_until, includes = excluded.includes,
    notes = excluded.notes, contact = excluded.contact, source = 'form', created_at = now();
  update public.rfq_invites set responded_at = now(), declined = false where id = i.id;
  if r.status in ('draft', 'sent') then update public.rfqs set status = 'quoted' where id = r.id; end if;
  insert into public.rfq_events (rfq_id, by, text) values (r.id, c.name, format('Προσφορά %s %s', price, coalesce(nullif(p_quote->>'currency', ''), 'EUR')));
  return jsonb_build_object('ok', true);
end $$;

revoke all on function public.rfq_public_get(text) from public;
revoke all on function public.rfq_public_submit(text, jsonb) from public;
grant execute on function public.rfq_public_get(text) to anon, authenticated;
grant execute on function public.rfq_public_submit(text, jsonb) to anon, authenticated;

-- ------------------------------------------------------------------ outbox (Outlook του υπολογιστή)
create or replace function public.mail_outbox_done(p_id bigint, p_ok boolean, p_error text default null)
returns void language plpgsql security definer set search_path = public as $$
declare m public.mail_outbox;
begin
  if auth.uid() is null then raise exception 'Απαιτείται σύνδεση'; end if;
  update public.mail_outbox set status = case when p_ok then 'sent' else 'error' end, sent_at = case when p_ok then now() end, error = p_error
  where id = p_id returning * into m;
  if m.rfq_id is not null then
    insert into public.rfq_events (rfq_id, by, text)
    values (m.rfq_id, 'Outlook', case when p_ok then 'Στάλθηκε email: ' || m.subject || ' → ' || array_to_string(m.to_addrs, ', ') else 'Αποτυχία email: ' || coalesce(p_error, '') end);
    if p_ok then update public.rfq_invites set sent_at = coalesce(sent_at, now()) where rfq_id = m.rfq_id and emails && m.to_addrs; end if;
  end if;
end $$;
revoke all on function public.mail_outbox_done(bigint, boolean, text) from public, anon;
grant execute on function public.mail_outbox_done(bigint, boolean, text) to authenticated;
