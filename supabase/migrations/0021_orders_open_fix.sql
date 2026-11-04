-- 1) Οι ανοιχτές λίστες επιστρέφονται ως ΕΝΑΣ πίνακας (text[]): το PostgREST κόβει τα
--    αποτελέσματα «setof» στις 1000 γραμμές, οπότε >1000 ανοιχτές λίστες δεν ξαναελέγχονταν
--    (π.χ. ολοκληρωμένες στο WMS που έμεναν «ανοιχτές» στην εφαρμογή). Το JSON που
--    επιστρέφεται είναι ίδιο (πίνακας από strings), οπότε το sync δεν αλλάζει.
-- 2) Η «τελευταία ημερομηνία» αγνοεί μελλοντικές ημερομηνίες (λάθη πληκτρολόγησης στο WMS,
--    π.χ. 18/12/2026), αλλιώς το sync ξεκινούσε από το μέλλον και δεν έβλεπε τις σημερινές.
drop function if exists public.wms_open_lists(text);
create function public.wms_open_lists(p_doc_type text default 'SALEXPORTLS')
returns text[]
language sql stable security definer set search_path = public
as $$
  select coalesce(array_agg(distinct order_id), '{}')
  from public.wms_orders
  where doc_type = p_doc_type and not is_completed and order_id ~ '^\d+$'
$$;
revoke all on function public.wms_open_lists(text) from public, anon;
grant execute on function public.wms_open_lists(text) to authenticated, service_role;

create or replace function public.wms_orders_last(p_doc_type text default 'SALEXPORTCL')
returns timestamptz
language sql stable security definer set search_path = public
as $$
  select max(order_date) from public.wms_orders
  where doc_type = p_doc_type and order_date <= now() + interval '1 day'
$$;
