-- Fagron -- Ανασυσκευασία: στοιχεία ετικέτας ανά τελικό κωδικό (εφαρμόστηκε 2026-11-03)
--   description_en        : αγγλική περιγραφή που έγραψε χρήστης (υπερισχύει)
--   description_en_wms    : αγγλική περιγραφή από το WMS (ms_Item.AlterDescr, μέσω sync)
--   units_per_package_wms : τμχ/συσκευασία από το WMS (αν βρεθεί πεδίο)
alter table public.repack_product_settings add column if not exists description_en text not null default '';
alter table public.repack_product_settings add column if not exists description_en_wms text not null default '';
alter table public.repack_product_settings add column if not exists units_per_package_wms int
  check (units_per_package_wms is null or units_per_package_wms > 0);

-- items: [{ code, description_en, units_per_package }] -- γράφει ΜΟΝΟ τα *_wms πεδία
create or replace function public.repack_update_item_info(items jsonb)
returns int language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if auth.uid() is null then raise exception 'Απαιτείται σύνδεση'; end if;
  if jsonb_typeof(items) <> 'array' then raise exception 'Λάθος μορφή'; end if;
  insert into public.repack_product_settings (product_code, description_en_wms, units_per_package_wms)
  select upper(trim(i->>'code')),
         coalesce(trim(i->>'description_en'), ''),
         case when coalesce(i->>'units_per_package', '') ~ '^\d+(\.0+)?$' and (i->>'units_per_package')::numeric > 0
              then (i->>'units_per_package')::numeric::int end
  from jsonb_array_elements(items) as t(i)
  where coalesce(trim(i->>'code'), '') <> ''
  on conflict (product_code) do update
    set description_en_wms = excluded.description_en_wms,
        units_per_package_wms = coalesce(excluded.units_per_package_wms, repack_product_settings.units_per_package_wms)
    where repack_product_settings.description_en_wms is distinct from excluded.description_en_wms
       or (excluded.units_per_package_wms is not null and repack_product_settings.units_per_package_wms is distinct from excluded.units_per_package_wms);
  get diagnostics n = row_count;
  return n;
end;
$$;

revoke all on function public.repack_update_item_info(jsonb) from public, anon;
grant execute on function public.repack_update_item_info(jsonb) to authenticated;
