-- One row per month per shop, and the gate that decides whether anything may
-- be posted into it.
--
-- ## Three states, not two
--
--   open    -- everything posts
--   closed  -- ordinary posting is refused; an owner may still post an
--              adjusting entry dated into the month, and the month can be
--              re-opened. Reversible, and audited.
--   locked  -- nothing posts, ever. Manual, deliberate, final.
--
-- The middle state exists because August's electricity bill arrives in
-- September. With only open and locked, a month is either editable forever --
-- which is what closing exists to prevent -- or a genuinely late bill has
-- nowhere to go and the shop learns to backdate the next one instead.
--
-- ## Why rows are created on demand
--
-- A shop should not have to be configured before it can trade. Rather than
-- seeding twelve months per shop per year -- which would need a job, and would
-- be wrong for a shop that opens in March -- the first thing to ask about a
-- month opens it. That makes the absence of a row mean "nobody has traded in
-- this month yet", which is a true and useful thing for it to mean.

create table public.accounting_periods (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  -- Always the first and last day of one calendar month. Stored as a range
  -- rather than a year+month pair so a future non-calendar period (a 4-4-5
  -- retail month) needs no migration, and so the containment test below is an
  -- ordinary BETWEEN rather than date arithmetic.
  starts_on date not null,
  ends_on date not null,
  status text not null default 'open' check (status in ('open','closed','locked')),
  closed_at timestamptz,
  closed_by uuid references auth.users(id),
  -- What was still unresolved when it closed. A month closed with a stock count
  -- outstanding is still closed -- refusing would mean shops that never count
  -- never close -- but which corners were cut has to survive on the record.
  exceptions text[] not null default '{}',
  created_at timestamptz not null default now(),
  constraint accounting_periods_ordered check (ends_on >= starts_on),
  unique (shop_id, starts_on)
);
create index accounting_periods_shop_idx on public.accounting_periods(shop_id, starts_on desc);

alter table public.accounting_periods enable row level security;

create policy "read accounting_periods" on public.accounting_periods for select
  using (has_shop_permission(shop_id, 'ledger.view'));
create policy "write accounting_periods" on public.accounting_periods for all
  using (has_shop_permission(shop_id, 'ledger.close'))
  with check (has_shop_permission(shop_id, 'ledger.close'));

grant select, insert, update on public.accounting_periods to authenticated;

-- The gate. Returns the period a date belongs to, opening it if it is the
-- first time anyone has asked, and raising if it is shut.
--
-- security definer because it INSERTS: a member holding ledger.post but not
-- ledger.close must be able to post into a month nobody has opened yet, and
-- the write policy above would refuse them. What they cannot do is re-open a
-- closed one -- this function never changes an existing row's status.
create or replace function public.open_period_for(p_shop_id uuid, p_on date)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_id uuid;
  v_status text;
  v_start date := date_trunc('month', p_on)::date;
begin
  select id, status into v_id, v_status
    from public.accounting_periods
   where shop_id = p_shop_id and p_on between starts_on and ends_on;

  if v_id is null then
    insert into public.accounting_periods (shop_id, starts_on, ends_on)
      values (p_shop_id, v_start, (v_start + interval '1 month - 1 day')::date)
    -- Two concurrent first-entries of a month race here. The loser takes the
    -- winner's row rather than failing, which is why this is on conflict and
    -- not a plain insert.
    on conflict (shop_id, starts_on) do update set starts_on = excluded.starts_on
    returning id, status into v_id, v_status;
  end if;

  if v_status <> 'open' then
    raise exception 'This period is % — posting into it is refused. Re-open it first.', v_status
      using errcode = 'P0001';
  end if;

  return v_id;
end;
$$;

grant execute on function public.open_period_for(uuid, date) to authenticated;
