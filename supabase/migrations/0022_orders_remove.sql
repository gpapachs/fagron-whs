-- Λίστες που διαγράφηκαν στο WMS (π.χ. ξαναστάλθηκε η παραγγελία από το ERP σε νέα λίστα):
-- το sync τις αφαιρεί και από την εφαρμογή. Μόνο μη ολοκληρωμένες, μόνο αριθμητικά ID του WMS.
create or replace function public.wms_orders_remove(p_doc_type text, p_order_ids text[])
returns integer
language plpgsql security definer set search_path = public
as $$
declare n integer;
begin
  delete from public.wms_orders
  where doc_type = p_doc_type and order_id = any(p_order_ids) and not is_completed and order_id ~ '^\d+$';
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.wms_orders_remove(text, text[]) from public, anon;
grant execute on function public.wms_orders_remove(text, text[]) to authenticated, service_role;
