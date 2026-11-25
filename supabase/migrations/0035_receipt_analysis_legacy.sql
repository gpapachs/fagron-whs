-- Ανάλυση παραλαβών: η ανάλωση του κωδικού μετράει και τους παλιούς κωδικούς του (item_legacy,
-- π.χ. 40-… για 41-…)· επιστρέφει και ποιοι είναι και πόση ανάλωση έφεραν.
drop function if exists public.wms_receipt_analysis(text, date);
create or replace function public.wms_receipt_analysis(p_prefix text, p_from date)
returns table (
  item text, description text, lot text, first_receipt timestamptz, last_receipt timestamptz, supplier text,
  received numeric, stock numeric, expiry date, positions text, lot_out_n integer, lot_out_last timestamptz,
  item_out_n integer, item_out_qty numeric, item_out_last timestamptz, item_stock numeric, item_lots integer,
  lot_positions integer, item_positions integer, pal_manual numeric, pal_manual_by text, pal_wms_ppp numeric, pal_wms_p2m numeric, pal_wms_units text,
  legacy_codes text, legacy_out_n integer, legacy_out_qty numeric
)
language sql stable security definer set search_path = public
as $$
  with p as (select regexp_replace(coalesce(p_prefix, ''), '[^0-9A-Za-z-]', '', 'g') || '%' as pat,
                    (p_from::timestamp at time zone 'Europe/Athens') as since),
  rec as (
    select m.item, coalesce(m.lot, '') lot, sum(m.qty) rq, min(m.moved_at) d1, max(m.moved_at) d2,
           string_agg(distinct nullif(m.customer, ''), ' / ') sup
    from wms_moves m, p
    where m.type = '12' and coalesce(m.from_pos, '') = '' and coalesce(m.to_pos, '') <> ''
      and m.item like p.pat and m.moved_at >= p.since
    group by 1, 2),
  st as (
    select s.item, coalesce(s.lot, '') lot, sum(s.qty) sq, min(s.expiry) exp, max(s.description) descr,
           count(distinct s.position)::int npos,
           string_agg(s.position || ' (' || trim(trailing '.' from trim(trailing '0' from round(s.qty::numeric, 3)::text)) || ')', ', ' order by s.position) pos
    from wms_stock_v s, p where s.item like p.pat group by 1, 2),
  outs as (
    select m.* from wms_moves m, p
    where m.item like p.pat and m.moved_at >= p.since
      and ((m.type = '12' and coalesce(m.from_pos, '') <> '' and coalesce(m.to_pos, '') = '') or m.type in ('20', '22'))),
  lo as (
    select o.item, coalesce(o.lot, '') lot, count(*)::int n, max(o.moved_at) last
    from outs o join rec r on r.item = o.item and r.lot = coalesce(o.lot, '') and o.moved_at >= r.d1
    group by 1, 2),
  -- παλιοί κωδικοί των κωδικών που παραλήφθηκαν, και οι έξοδοί τους στην περίοδο
  lk as (select l.code item, l.old_code old from item_legacy l where l.code in (select distinct item from rec)),
  lout as (
    select lk.item, count(*)::int n, sum(m.qty) q, max(m.moved_at) last
    from lk join wms_moves m on m.item = lk.old, p
    where m.moved_at >= p.since
      and ((m.type = '12' and coalesce(m.from_pos, '') <> '' and coalesce(m.to_pos, '') = '') or m.type in ('20', '22'))
    group by 1),
  lnames as (select item, string_agg(old, ', ' order by old) codes from lk group by 1),
  io0 as (select item, count(*)::int n, sum(qty) q, max(moved_at) last from outs group by 1),
  io as (
    select coalesce(a.item, b.item) item, coalesce(a.n, 0) + coalesce(b.n, 0) n, coalesce(a.q, 0) + coalesce(b.q, 0) q,
           greatest(a.last, b.last) last
    from io0 a full join lout b on b.item = a.item),
  ist as (select s.item, sum(s.qty) sq, count(distinct coalesce(s.lot, ''))::int lots, count(distinct s.position)::int npos from wms_stock_v s, p where s.item like p.pat group by 1)
  select rec.item, coalesce(st.descr, i.description), rec.lot, rec.d1, rec.d2, rec.sup,
         rec.rq, coalesce(st.sq, 0), st.exp, st.pos, coalesce(lo.n, 0), lo.last,
         coalesce(io.n, 0), coalesce(io.q, 0), io.last, coalesce(ist.sq, 0), coalesce(ist.lots, 0),
         coalesce(st.npos, 0), coalesce(ist.npos, 0), pq.qty, pq.updated_by, wp.pieces_per_pal, wp.pal_to_mu1, wp.units,
         lnames.codes, coalesce(lout.n, 0), coalesce(lout.q, 0)
  from rec
  left join st on st.item = rec.item and st.lot = rec.lot
  left join lo on lo.item = rec.item and lo.lot = rec.lot
  left join io on io.item = rec.item
  left join ist on ist.item = rec.item
  left join lnames on lnames.item = rec.item
  left join lout on lout.item = rec.item
  left join wms_items i on i.code = rec.item
  left join item_pallet_qty pq on pq.item = upper(rec.item)
  left join wms_item_pack wp on wp.item = upper(rec.item)
  order by rec.d1
$$;
revoke all on function public.wms_receipt_analysis(text, date) from public, anon;
grant execute on function public.wms_receipt_analysis(text, date) to authenticated;
