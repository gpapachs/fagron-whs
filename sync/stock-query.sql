-- Απόθεμα από το WMS (192.168.1.22\SQLEXPRESS). ΜΟΝΟ SELECT.
-- Οι στήλες βγαίνουν με τα ονόματα που περιμένει το script:
--   position, item, qty (υποχρεωτικά) + area, description, unit, lot, expiry
--
-- dbo.ms_Stock: ένα υπόλοιπο ανά θέση/είδος/παρτίδα (Qty1 = «Ποσ1» του Excel)
-- dbo.ms_Item : κωδικός/περιγραφή είδους
-- dbo.ms_Pos  : κωδικός/περιγραφή θέσης  <-- αν βγει «Invalid object name»,
--               τρέξε  .\sync-stock.cmd -Describe Pos  και στείλε το αποτέλεσμα

select
  p.code      as position,
  p.Descr     as area,
  i.code      as item,
  i.Descr     as description,
  s.Qty1      as qty,
  s.Lot       as lot,
  s.ExpDate   as expiry
from dbo.ms_Stock s
join dbo.ms_Item i on i.ID = s.ItemId
join dbo.ms_Pos  p on p.ID = s.PosId
where s.Qty1 > 0
