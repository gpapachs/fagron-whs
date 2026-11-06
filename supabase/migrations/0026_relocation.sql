drop function if exists public.wms_relocation_data(text, date);
-- Πλάνο μεταφοράς αποθέματος: απόθεμα ανά θέση/παρτίδα για ένα πρόθεμα κωδικών, μαζί με την
-- κατανάλωση του κωδικού από μια ημερομηνία, τη ζήτηση ανοιχτών παραγγελιών (SALEXPORTLS) και
-- την ποσότητα ανά παλέτα. Οι υπολογισμοί (τι μένει / τι φεύγει) γίνονται στην εφαρμογή.
create or replace function public.wms_relocation_data(p_prefix text, p_from date)
returns table (
  item text, description text, pos text, area text, lot text, expiry date, qty numeric,
  lot_first_receipt timestamptz,
  item_out_qty numeric, item_out_n integer, item_out_last timestamptz, item_first_move timestamptz,
  open_demand numeric, open_lists integer,
  pal_manual numeric, pal_manual_by text, pal_wms_ppp numeric, pos_other_rows integer, item_first_receipt timestamptz
)
language sql stable security definer set search_path = public
as $$
  with p as (select regexp_replace(coalesce(p_prefix, ''), '[^0-9A-Za-z-]', '', 'g') || '%' as pat,
                    (p_from::timestamp at time zone 'Europe/Athens') as since),
  st as (select s.* from wms_stock_v s, p where s.item like p.pat and s.qty > 0),
  outs as (
    select m.item, sum(m.qty) q, count(*)::int n, max(m.moved_at) last
    from wms_moves m, p
    where m.item like p.pat and m.moved_at >= p.since
      and ((m.type = '12' and coalesce(m.from_pos, '') <> '' and coalesce(m.to_pos, '') = '') or m.type in ('20', '22'))
    group by 1),
  firstm as (select m.item, min(m.moved_at) f from wms_moves m, p where m.item like p.pat group by 1),
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
  -- γραμμές άλλων κωδικών (εκτός προθέματος) στην ίδια θέση: για το «ελευθερώνεται η θέση»
  oth as (select s.position, count(*)::int n from wms_stock_v s, p where s.qty > 0 and s.item not like p.pat and s.position in (select position from st) group by 1)
  select st.item, st.description, st.position, st.area, coalesce(st.lot, ''), st.expiry, st.qty,
         rcv.d1, coalesce(outs.q, 0), coalesce(outs.n, 0), outs.last, firstm.f,
         coalesce(dem.q, 0), coalesce(dem.n, 0),
         pq.qty, pq.updated_by, wp.pieces_per_pal, coalesce(oth.n, 0), rcvi.f
  from st
  left join outs on outs.item = st.item
  left join firstm on firstm.item = st.item
  left join rcv on rcv.item = st.item and rcv.lot = coalesce(st.lot, '')
  left join dem on dem.item = st.item
  left join item_pallet_qty pq on pq.item = upper(st.item)
  left join wms_item_pack wp on wp.item = upper(st.item)
  left join oth on oth.position = st.position
  left join rcvi on rcvi.item = st.item
  order by st.item, st.position
$$;
revoke all on function public.wms_relocation_data(text, date) from public, anon;
grant execute on function public.wms_relocation_data(text, date) to authenticated;
