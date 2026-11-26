-- Κέρδος από τους γύρους τιμών: round_baseline = χαμηλότερη EUR τιμή πριν τον 1ο γύρο.
-- Στην ανάθεση: κέρδος = max(0, min(baseline, αρχική τιμή νικητή) − τελική τιμή νικητή) — αποθηκεύεται (trigger).
alter table public.rfqs
  add column if not exists round_baseline numeric,
  add column if not exists round_saving numeric,
  add column if not exists round_saving_at timestamptz;

create or replace function public.rfq_round_saving() returns trigger language plpgsql security definer set search_path = public as $$
declare q public.quotes;
begin
  if new.awarded_quote is distinct from old.awarded_quote or new.round_baseline is distinct from old.round_baseline then
    if new.awarded_quote is null or new.round_baseline is null then
      new.round_saving := null; new.round_saving_at := null;
    else
      select * into q from public.quotes where id = new.awarded_quote;
      if found and q.currency = 'EUR' then
        new.round_saving := greatest(0, least(new.round_baseline, coalesce(q.first_price, q.price)) - q.price);
        new.round_saving_at := now();
      else
        new.round_saving := null; new.round_saving_at := null;
      end if;
    end if;
  end if;
  return new;
end $$;
drop trigger if exists rfq_round_saving on public.rfqs;
create trigger rfq_round_saving before update on public.rfqs for each row execute function public.rfq_round_saving();

create or replace function public.quote_round_saving() returns trigger language plpgsql security definer set search_path = public as $$
begin
  update public.rfqs r set round_saving = greatest(0, least(r.round_baseline, coalesce(new.first_price, new.price)) - new.price), round_saving_at = now()
  where r.awarded_quote = new.id and r.round_baseline is not null and new.currency = 'EUR';
  return null;
end $$;
drop trigger if exists quote_round_saving on public.quotes;
create trigger quote_round_saving after update of price, first_price on public.quotes for each row execute function public.quote_round_saving();
