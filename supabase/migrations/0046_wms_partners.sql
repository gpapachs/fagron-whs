-- Πελάτες / προμηθευτές από το WMS (dbo.ms_Person, IsCustomer / IsSupplier) — μόνο ανάγνωση από το WMS.
-- Το sync ανεβάζει τα ακατέργαστα στοιχεία· η χώρα / Ελλάδα-εξωτερικό υπολογίζεται στο wms_partners_v
-- ώστε ο κανόνας να διορθώνεται χωρίς νέο sync. Χειροκίνητη διόρθωση χώρας: wms_partner_country.
create table if not exists public.wms_partners (
  id bigint primary key,
  code text,
  name text,
  is_customer boolean not null default false,
  is_supplier boolean not null default false,
  active boolean not null default true,
  vat text,
  vat_eu text,
  address text,
  city text,
  zip text,
  phone text,
  phone2 text,
  email text,
  contact text,
  erp_code text,
  upd_at timestamptz,
  synced_at timestamptz not null default now()
);
alter table public.wms_partners enable row level security;
create policy wms_partners_read on public.wms_partners for select to authenticated using (true);

create table if not exists public.wms_partner_country (
  id bigint primary key,
  country text not null,
  updated_by text,
  updated_at timestamptz not null default now()
);
alter table public.wms_partner_country enable row level security;
create policy wms_partner_country_read on public.wms_partner_country for select to authenticated using (true);
create policy wms_partner_country_write on public.wms_partner_country for all to authenticated using (true) with check (true);

create or replace function public.wms_partners_upload(p_rows jsonb, p_run timestamptz)
returns integer language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  if auth.uid() is null then raise exception 'Απαιτείται σύνδεση'; end if;
  insert into public.wms_partners as w (id, code, name, is_customer, is_supplier, active, vat, vat_eu, address, city, zip, phone, phone2, email, contact, erp_code, upd_at, synced_at)
  select (r->>'id')::bigint, nullif(trim(r->>'code'), ''), nullif(trim(r->>'name'), ''),
         coalesce((r->>'is_customer')::boolean, false), coalesce((r->>'is_supplier')::boolean, false), coalesce((r->>'active')::boolean, true),
         nullif(trim(r->>'vat'), ''), nullif(trim(r->>'vat_eu'), ''), nullif(trim(r->>'address'), ''), nullif(trim(r->>'city'), ''),
         nullif(trim(r->>'zip'), ''), nullif(trim(r->>'phone'), ''), nullif(trim(r->>'phone2'), ''), nullif(trim(r->>'email'), ''),
         nullif(trim(r->>'contact'), ''), nullif(trim(r->>'erp_code'), ''), nullif(r->>'upd_at', '')::timestamptz, p_run
  from jsonb_array_elements(p_rows) r
  where coalesce(r->>'id', '') ~ '^\d+$'
  on conflict (id) do update set code = excluded.code, name = excluded.name, is_customer = excluded.is_customer, is_supplier = excluded.is_supplier,
    active = excluded.active, vat = excluded.vat, vat_eu = excluded.vat_eu, address = excluded.address, city = excluded.city, zip = excluded.zip,
    phone = excluded.phone, phone2 = excluded.phone2, email = excluded.email, contact = excluded.contact, erp_code = excluded.erp_code,
    upd_at = excluded.upd_at, synced_at = excluded.synced_at;
  get diagnostics n = row_count;
  return n;
end $$;

-- μετά από πλήρες ανέβασμα: σβήνει όσους δεν είναι πια πελάτες / προμηθευτές στο WMS
create or replace function public.wms_partners_prune(p_run timestamptz)
returns integer language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  if auth.uid() is null then raise exception 'Απαιτείται σύνδεση'; end if;
  delete from public.wms_partners where synced_at < p_run;
  get diagnostics n = row_count;
  insert into public.wms_live (key, at, items, n) values ('partners', now(), '{}', 0)
  on conflict (key) do update set at = now(), n = public.wms_live.n + 1;
  return n;
end $$;
revoke all on function public.wms_partners_upload(jsonb, timestamptz) from public, anon;
revoke all on function public.wms_partners_prune(timestamptz) from public, anon;
grant execute on function public.wms_partners_upload(jsonb, timestamptz) to authenticated;
grant execute on function public.wms_partners_prune(timestamptz) to authenticated;

-- Χώρα: (1) χειροκίνητη διόρθωση, (2) πρόθεμα ΑΦΜ (EL -> GR), (3) ελληνικοί χαρακτήρες σε πόλη / διεύθυνση
-- ή ελληνικός ΤΚ με 9ψήφιο ΑΦΜ -> GR, (4) αλλιώς εξωτερικό με άγνωστη χώρα.
create or replace view public.wms_partners_v with (security_invoker = true) as
with b as (
  select w.*,
    upper(regexp_replace(coalesce(nullif(w.vat_eu, ''), w.vat, ''), '[\s.\-]', '', 'g')) as v,
    regexp_replace(coalesce(w.zip, ''), '\s', '', 'g') as z,
    c.country as manual
  from public.wms_partners w left join public.wms_partner_country c on c.id = w.id
), k as (
  select b.*,
    case
      when manual is not null then upper(manual)
      when v ~ '^[A-Z]{2}' then case when left(v, 2) in ('EL', 'GR') then 'GR' else left(v, 2) end
      when coalesce(city, '') || coalesce(address, '') ~ '[Α-Ωα-ωΆ-Ώά-ώ]' then 'GR'
      when z ~ '^[1-8][0-9]{4}$' and v ~ '^[0-9]{9}$' then 'GR'
      when z = '' and v ~ '^[0-9]{9}$' then 'GR'
      when z = '' and v = '' and coalesce(city, '') = '' and coalesce(address, '') = '' then null
      else ''
    end as country
  from b
)
select id, code, name, is_customer, is_supplier, active, vat, vat_eu, address, city, zip, phone, phone2, email, contact, erp_code, upd_at, synced_at,
  country, (country is not null and country <> 'GR') as is_abroad, (manual is not null) as country_manual
from k;
grant select on public.wms_partners_v to authenticated;
