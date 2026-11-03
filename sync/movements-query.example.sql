-- Κινήσεις WMS -> εφαρμογή (σελίδα «Κινήσεις»). ΜΟΝΟ SELECT.
-- Μετονόμασε σε movements-query.sql όταν συμπληρωθούν οι σωστοί πίνακες/στήλες
-- (θα τα βάλει ο Claude από το wms-kiniseis.txt που βγάζει το: sync-stock.cmd -Moves).
-- Πρέπει να επιστρέφει αυτά τα ονόματα στηλών (όσα υπάρχουν):
--   id, moved_at, type, doc, item, lot, serial, qty, from_pos, to_pos, customer, username
-- και να φιλτράρει με την παράμετρο @since (μόνο νέες κινήσεις κάθε φορά).
select
  cast(t.ID as varchar(40)) as id,
  t.TransDate              as moved_at,
  tt.Descr                 as type,
  t.DocNo                  as doc,
  i.code                   as item,
  t.Lot                    as lot,
  t.SerialNo               as serial,
  t.Qty                    as qty,
  pf.code                  as from_pos,
  pt.code                  as to_pos,
  c.Descr                  as customer,
  u.UserName               as username
from dbo.ms_Trans t
join dbo.ms_Item i on i.ID = t.ItemId
left join dbo.ms_Pos pf on pf.ID = t.FromPosId
left join dbo.ms_Pos pt on pt.ID = t.ToPosId
left join dbo.ms_TransType tt on tt.ID = t.TypeId
left join dbo.ms_Customer c on c.ID = t.CustomerId
left join dbo.ms_User u on u.ID = t.UserId
where t.TransDate >= @since
