-- Fagron -- ασφάλεια: κανένας δεν καλεί μέσω API συναρτήσεις που δεν πρέπει
-- (εφαρμόστηκε 2026-10-30 μετά από Supabase security advisor). Ασφαλές να ξανατρέξει.

-- trigger functions: δεν καλούνται ποτέ μέσω API (οι triggers τρέχουν ανεξάρτητα από το EXECUTE)
revoke execute on function public.handle_new_user() from public, anon, authenticated;
revoke execute on function public.log_position_change() from public, anon, authenticated;
revoke execute on function public.repack_jobs_set_user() from public, anon, authenticated;
revoke execute on function public.repack_settings_stamp() from public, anon, authenticated;

-- is_admin: χρειάζεται για τα RLS των συνδεδεμένων, όχι για ανώνυμους
revoke execute on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated;

-- RPC ανεβάσματος: μόνο συνδεδεμένοι (ελέγχουν και μέσα auth.uid() / is_admin)
revoke execute on function public.repack_replace_recipes(jsonb, text) from public, anon;
revoke execute on function public.repack_replace_stock(jsonb, text) from public, anon;
revoke execute on function public.repack_replace_reserved(jsonb, text) from public, anon;
grant execute on function public.repack_replace_recipes(jsonb, text) to authenticated;
grant execute on function public.repack_replace_stock(jsonb, text) to authenticated;
grant execute on function public.repack_replace_reserved(jsonb, text) to authenticated;
