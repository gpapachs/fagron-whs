-- Πλάνο μεταφοράς v2: η κατανάλωση ενός κωδικού μετράει ΚΑΙ τους παλιούς κωδικούς που
-- αντικατέστησε (π.χ. το καλοκαίρι οι 40-xx-xxx έγιναν 41-xx-xxx με την ίδια περιγραφή).
-- Αντιστοίχιση: ίδια περιγραφή (ίδιες λέξεις, χωρίς διαφορά σε κενά/κεφαλαία/σειρά) με κωδικό που ξεκινά από p_legacy.
-- Επιστρέφει και ποιοι παλιοί κωδικοί συνδέθηκαν και πόση κατανάλωση έφεραν, για έλεγχο.
drop function if exists public.wms_relocation_data_v2(text, date, text);
create or replace function public.wms_relocation_data_v2(p_prefix text, p_from date, p_legacy text default null)
returns table (
  item text, description text, pos text, area text, lot text, expiry date, qty numeric,
  lot_first_receipt timestamptz,
  item_out_qty numeric, item_out_n integer, item_out_last timestamptz, item_first_move timestamptz,
  open_demand numeric, open_lists integer,
  pal_manual numeric, pal_manual_by text, pal_wms_ppp numeric, pos_other_rows integer, item_first_receipt timestamptz,
  legacy_codes text, legacy_out_qty numeric, legacy_first_move timestamptz
)
language sql stable security definer set search_path = public
as $$
  with p as (select regexp_replace(coalesce(p_prefix, ''), '[^0-9A-Za-z-]', '', 'g') || '%' as pat,
                    nullif(regexp_replace(coalesce(p_legacy, ''), '[^0-9A-Za-z-]', '', 'g'), '') as lpre,
                    (p_from::timestamp at time zone 'Europe/Athens') as since),
  st as (select s.* from wms_stock_v s, p where s.item like p.pat and s.qty > 0),
  -- ίδια περιγραφή = ίδιες λέξεις (κεφαλαία, με όποια σειρά: «ΠΕΡΙΕΚΤΗΣ ΓΥΑΛΙΝΟΣ» = «ΓΥΑΛΙΝΟΣ ΠΕΡΙΕΚΤΗΣ»)
  norm as (
    select i.code as item,
           array_to_string(array(select w from unnest(string_to_array(upper(regexp_replace(trim(coalesce(i.description, '')), '\s+', ' ', 'g')), ' ')) w where w <> '' order by w), ' ') d
    from wms_items i),
  -- νέος κωδικός -> παλιοί κωδικοί με ίδια περιγραφή
  link as (
    select distinct n1.item, n0.item old
    from (select distinct st.item from st) x
    join norm n1 on n1.item = x.item and n1.d <> ''
    join norm n0 on n0.d = n1.d and n0.item <> n1.item, p
    where p.lpre is not null and n0.item like p.lpre || '%'),
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
  rcv as (
    select m.item, coalesce(m.lot, '') lot, min(m.moved_at) d1
    from wms_moves m, p
    where m.item like p.pat and m.type = '12' and coalesce(m.from_pos, '') = '' and coalesce(m.to_pos, '') <> ''
    group by 1, 2),
  rcvi as (select item, min(d1) f from rcv group by 1),
  dem as (
    select o.item, sum(greatest(o.qty, 0)) q, count(distinct o.order_id)::int n
    from wms_orders o, p
    where o.doc_type = 'SALEXPORTLS' and not coalesce(o.is_completed, false) and o.item like p.pat and o.qty > 0
      and o.order_date >= now() - interval '60 days'
    group by 1),
  oth as (select s.position, count(*)::int n from wms_stock_v s, p where s.qty > 0 and s.item not like p.pat and s.position in (select position from st) group by 1)
  select st.item, st.description, st.position, st.area, coalesce(st.lot, ''), st.expiry, st.qty,
         rcv.d1, coalesce(outs.q, 0), coalesce(outs.n, 0), outs.last, firstm.f,
         coalesce(dem.q, 0), coalesce(dem.n, 0),
         pq.qty, pq.updated_by, wp.pieces_per_pal, coalesce(oth.n, 0), rcvi.f,
         lnames.codes, coalesce(outs.lq, 0), firstm.lf
  from st
  left join outs on outs.item = st.item
  left join firstm on firstm.item = st.item
  left join lnames on lnames.item = st.item
  left join rcv on rcv.item = st.item and rcv.lot = coalesce(st.lot, '')
  left join dem on dem.item = st.item
  left join item_pallet_qty pq on pq.item = upper(st.item)
  left join wms_item_pack wp on wp.item = upper(st.item)
  left join oth on oth.position = st.position
  left join rcvi on rcvi.item = st.item
  order by st.item, st.position
$$;
revoke all on function public.wms_relocation_data_v2(text, date, text) from public, anon;
grant execute on function public.wms_relocation_data_v2(text, date, text) to authenticated;
