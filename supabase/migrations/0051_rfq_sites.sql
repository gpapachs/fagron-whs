-- Τόπος φόρτωσης / παράδοσης διαφορετικός από τη διεύθυνση του πελάτη / προμηθευτή.
-- rfqs.customer_* = έδρα πελάτη (εσωτερικά)· from_* / to_* = πραγματικός τόπος (βλέπει η μεταφορική).
alter table public.rfqs
  add column if not exists customer_code text,
  add column if not exists customer_address text,
  add column if not exists customer_city text,
  add column if not exists customer_zip text,
  add column if not exists customer_country text,
  add column if not exists other_site boolean not null default false,
  add column if not exists site_contact text,
  add column if not exists site_phone text,
  add column if not exists site_hours text;

-- αποθηκευμένοι τόποι ανά πελάτη / προμηθευτή (κωδικός WMS ή όνομα)
create table if not exists public.partner_sites (
  id uuid primary key default gen_random_uuid(),
  partner_code text,
  partner_name text not null,
  label text,
  company text,
  address text,
  city text not null,
  zip text,
  country text,
  contact text,
  phone text,
  hours text,
  notes text,
  created_at timestamptz not null default now(),
  created_by text
);
create index if not exists partner_sites_code on public.partner_sites (partner_code);
create index if not exists partner_sites_name on public.partner_sites (lower(partner_name));
alter table public.partner_sites enable row level security;
drop policy if exists partner_sites_all on public.partner_sites;
create policy partner_sites_all on public.partner_sites for all to authenticated using (true) with check (true);

-- δημόσια φόρμα: + επαφή / τηλέφωνο / ωράριο του τόπου (όχι η έδρα του πελάτη)
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
      'site_contact', r.site_contact, 'site_phone', r.site_phone, 'site_hours', r.site_hours,
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
revoke all on function public.rfq_public_get(text) from public;
grant execute on function public.rfq_public_get(text) to anon, authenticated;
