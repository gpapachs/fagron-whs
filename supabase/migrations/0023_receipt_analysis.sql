-- Ανάλυση παραλαβών: παρτίδες κωδικών με πρόθεμα που παραλήφθηκαν από προμηθευτή από μια
-- ημερομηνία και μετά, σε σύγκριση με το σημερινό απόθεμα (ανέγγιχτες / μερικώς / εξαντλήθηκαν),
-- μαζί με τα στοιχεία κατανάλωσης του κωδικού. Παραλαβή = κίνηση 12 χωρίς «από» θέση, προς θέση.
-- Έξοδος/ανάλωση = κίνηση 12 από θέση χωρίς «προς», ή 20 / 22 (πώληση).
create or replace function public.wms_receipt_analysis(p_prefix text, p_from date)
returns table (
  item text, description text, lot text, first_receipt timestamptz, last_receipt timestamptz, supplier text,
  received numeric, stock numeric, expiry date, positions text, lot_out_n integer, lot_out_last timestamptz,
  item_out_n integer, item_out_qty numeric, item_out_last timestamptz, item_stock numeric, item_lots integer
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
  io as (select item, count(*)::int n, sum(qty) q, max(moved_at) last from outs group by 1),
  ist as (select s.item, sum(s.qty) sq, count(distinct coalesce(s.lot, ''))::int lots from wms_stock_v s, p where s.item like p.pat group by 1)
  select rec.item, coalesce(st.descr, i.description), rec.lot, rec.d1, rec.d2, rec.sup,
         rec.rq, coalesce(st.sq, 0), st.exp, st.pos, coalesce(lo.n, 0), lo.last,
         coalesce(io.n, 0), coalesce(io.q, 0), io.last, coalesce(ist.sq, 0), coalesce(ist.lots, 0)
  from rec
  left join st on st.item = rec.item and st.lot = rec.lot
  left join lo on lo.item = rec.item and lo.lot = rec.lot
  left join io on io.item = rec.item
  left join ist on ist.item = rec.item
  left join wms_items i on i.code = rec.item
  order by rec.d1
$$;
revoke all on function public.wms_receipt_analysis(text, date) from public, anon;
grant execute on function public.wms_receipt_analysis(text, date) to authenticated;
