-- Ημερομηνία εισαγωγής παρτίδας από ΟΛΟ το ιστορικό του WMS (οι κινήσεις στην εφαρμογή ξεκινούν 02/01/2026).
-- Το sync ανεβάζει την πρώτη εισαγωγή (χωρίς «από θέση» -> σε θέση) ανά κωδικό + παρτίδα.
create table if not exists public.wms_lot_receipt (
  item text not null,
  lot text not null,
  first_receipt timestamptz not null,
  synced_at timestamptz not null default now(),
  primary key (item, lot)
);
create index if not exists wms_lot_receipt_lot on public.wms_lot_receipt (lot);
alter table public.wms_lot_receipt enable row level security;
create policy wms_lot_receipt_read on public.wms_lot_receipt for select to authenticated using (true);

create or replace function public.wms_lot_receipt_upload(p_rows jsonb)
returns integer language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  if auth.uid() is null then raise exception 'Απαιτείται σύνδεση'; end if;
  insert into public.wms_lot_receipt (item, lot, first_receipt, synced_at)
  select upper(r->>'item'), r->>'lot', (r->>'first_at')::timestamptz, now()
  from jsonb_array_elements(p_rows) r
  where coalesce(r->>'item', '') <> '' and coalesce(r->>'lot', '') <> '' and coalesce(r->>'first_at', '') <> ''
  on conflict (item, lot) do update set first_receipt = least(public.wms_lot_receipt.first_receipt, excluded.first_receipt), synced_at = now();
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.wms_lot_receipt_upload(jsonb) from public, anon;
grant execute on function public.wms_lot_receipt_upload(jsonb) to authenticated;

-- Μεταφορά: εισαγωγή παρτίδας = η νωρίτερη από (α) τον ίδιο κωδικό, (β) τον παλιό κωδικό (40*) της ίδιας παρτίδας
-- μέσω item_legacy, (γ) αν δεν βρεθεί, οποιονδήποτε παλιό κωδικό (πρόθεμα) με την ίδια παρτίδα. lot_receipt_from = ο
-- παλιός κωδικός όταν η ημερομηνία ήρθε από εκεί.
drop function if exists public.wms_relocation_data_v2(text, date, text);
create function public.wms_relocation_data_v2(p_prefix text, p_from date, p_legacy text default null)
returns table(item text, description text, pos text, area text, lot text, expiry date, qty numeric, lot_first_receipt timestamptz,
  item_out_qty numeric, item_out_n integer, item_out_last timestamptz, item_first_move timestamptz, open_demand numeric, open_lists integer,
  pal_manual numeric, pal_manual_by text, pal_wms_ppp numeric, pos_other_rows integer, item_first_receipt timestamptz,
  legacy_codes text, legacy_out_qty numeric, legacy_first_move timestamptz, lot_receipt_from text)
language sql stable security definer set search_path = public as $function$
  with p as (select regexp_replace(coalesce(p_prefix, ''), '[^0-9A-Za-z-]', '', 'g') || '%' as pat,
                    nullif(regexp_replace(coalesce(p_legacy, ''), '[^0-9A-Za-z-]', '', 'g'), '') as lpre,
                    (p_from::timestamp at time zone 'Europe/Athens') as since),
  st as (select s.* from wms_stock_v s, p where s.item like p.pat and s.qty > 0),
  link as (
    select distinct l.code item, l.old_code old
    from item_legacy l, p
    where p.lpre is not null and l.old_code like p.lpre || '%' and l.code in (select distinct item from st)),
  codes as (select item, item code from (select distinct item from st) x union all select item, old from link),
  outs_all as (
    select c.item, (c.code <> c.item) legacy, m.qty, m.moved_at
    from codes c join wms_moves m on m.item = c.code, p
    where m.moved_at >= p.since
      and ((m.type = '12' and coalesce(m.from_pos, '') <> '' and coalesce(m.to_pos, '') = '') or m.type in ('20', '22'))),
  outs as (select item, sum(qty) q, count(*)::int n, max(moved_at) last, sum(qty) filter (where legacy) lq from outs_all group by 1),
  firstm as (
    select c.item, min(m.moved_at) f, min(m.moved_at) filter (where c.code <> c.item) lf
    from codes c join wms_moves m on m.item = c.code group by 1),
  lnames as (select item, string_agg(old, ', ' order by old) codes from link group by 1),
  -- εισαγωγές: κινήσεις της εφαρμογής + ιστορικό WMS (wms_lot_receipt)
  rcv_all as (
    select m.item, coalesce(m.lot, '') lot, m.moved_at d
    from wms_moves m
    where m.type = '12' and coalesce(m.from_pos, '') = '' and coalesce(m.to_pos, '') <> ''
      and (m.item in (select code from codes) or m.item like (select lpre from p) || '%')
    union all
    select r.item, r.lot, r.first_receipt from wms_lot_receipt r
    where r.item in (select code from codes) or r.item like (select lpre from p) || '%' or r.item like (select pat from p)),
  rcv as (select item, lot, min(d) d1 from rcv_all group by 1, 2),
  rcvi as (select r.item, min(r.d1) f from rcv r where r.item in (select distinct item from st) group by 1),
  lots as (select distinct st.item, coalesce(st.lot, '') lot from st),
  lr as (
    select lots.item, lots.lot,
      own.d1 own_d,
      (select r.d1 from link k join rcv r on r.item = k.old and r.lot = lots.lot where k.item = lots.item order by r.d1 limit 1) leg_d,
      (select k.old from link k join rcv r on r.item = k.old and r.lot = lots.lot where k.item = lots.item order by r.d1 limit 1) leg_c,
      (select r.d1 from rcv r, p where lots.lot <> '' and p.lpre is not null and r.item like p.lpre || '%' and r.lot = lots.lot order by r.d1 limit 1) any_d,
      (select r.item from rcv r, p where lots.lot <> '' and p.lpre is not null and r.item like p.lpre || '%' and r.lot = lots.lot order by r.d1 limit 1) any_c
    from lots left join rcv own on own.item = lots.item and own.lot = lots.lot),
  lr2 as (
    select item, lot,
      case when leg_d is not null and (own_d is null or leg_d < own_d) then leg_d
           when own_d is not null then own_d
           else any_d end d,
      case when leg_d is not null and (own_d is null or leg_d < own_d) then leg_c
           when own_d is not null then null
           else any_c end c
    from lr),
  dem as (
    select o.item, sum(greatest(o.qty, 0)) q, count(distinct o.order_id)::int n
    from wms_orders o, p
    where o.doc_type = 'SALEXPORTLS' and not coalesce(o.is_completed, false) and o.item like p.pat and o.qty > 0
      and o.order_date >= now() - interval '60 days'
    group by 1),
  oth as (select s.position, count(*)::int n from wms_stock_v s, p where s.qty > 0 and s.item not like p.pat and s.position in (select position from st) group by 1)
  select st.item, st.description, st.position, st.area, coalesce(st.lot, ''), st.expiry, st.qty,
         lr2.d, coalesce(outs.q, 0), coalesce(outs.n, 0), outs.last, firstm.f,
         coalesce(dem.q, 0), coalesce(dem.n, 0),
         pq.qty, pq.updated_by, wp.pieces_per_pal, coalesce(oth.n, 0), rcvi.f,
         lnames.codes, coalesce(outs.lq, 0), firstm.lf, lr2.c
  from st
  left join outs on outs.item = st.item
  left join firstm on firstm.item = st.item
  left join lnames on lnames.item = st.item
  left join lr2 on lr2.item = st.item and lr2.lot = coalesce(st.lot, '')
  left join dem on dem.item = st.item
  left join item_pallet_qty pq on pq.item = upper(st.item)
  left join wms_item_pack wp on wp.item = upper(st.item)
  left join oth on oth.position = st.position
  left join rcvi on rcvi.item = st.item
  order by st.item, st.position
$function$;
revoke all on function public.wms_relocation_data_v2(text, date, text) from public, anon;
grant execute on function public.wms_relocation_data_v2(text, date, text) to authenticated;
grant execute on function public.wms_relocation_data_v2(text, date, text) to service_role;
