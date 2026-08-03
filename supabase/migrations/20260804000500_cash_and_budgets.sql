-- Cash on hand, recurring bills, and category budgets: the forward-looking
-- half of Accounting. Everything else here records what already happened;
-- this is about what's coming and whether there's money to meet it.
--
-- Worth stating because it's the classic way a shop gets caught out: profit
-- and cash are not the same thing. Buying stock drains the bank without being
-- an expense (it becomes COGS when it sells), so a profitable month can still
-- leave nothing in the till.

-- Where the shop's money physically is. A manually-maintained snapshot, not a
-- ledger derived from transactions: the owner counts the drawer and types what
-- they counted, and that figure is the one they trust. The app shows an
-- "expected change" alongside it rather than overwriting it -- a computed
-- balance that silently disagrees with the cash in hand is worse than useless.
create table public.cash_accounts (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  name text not null,
  account_type text not null default 'cash' check (account_type in ('cash','bank','mobile_money','other')),
  -- Deliberately allows negative: a bank account can be overdrawn, and
  -- refusing to record that would just push the owner to enter a wrong number.
  balance_cents integer not null default 0,
  notes text,
  -- When the balance was last confirmed, so "expected change since" has a
  -- point to measure from.
  balance_as_of timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  unique (shop_id, name)
);
create index cash_accounts_shop_id_idx on public.cash_accounts(shop_id);

-- Costs that repeat on a schedule -- rent, a mall service charge, an ad
-- retainer. A template, not an expense: nothing hits the P&L until the bill is
-- actually logged, because a bill that's due isn't a bill that's been incurred
-- until the period it covers arrives.
create table public.recurring_bills (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  name text not null,
  category text not null check (category in (
    'inventory_purchase','rent','utilities','salaries_wages','marketing',
    'supplies','transport_delivery','maintenance_repairs','fees_charges',
    'owner_draw','other'
  )),
  frequency text not null check (frequency in ('weekly','biweekly','monthly','quarterly','yearly')),
  amount_cents integer not null check (amount_cents > 0),
  payment_method text not null default 'cash' check (payment_method in ('cash','zaad','edahab','other')),
  next_due_date date not null,
  vendor_id uuid references public.vendors(id) on delete set null,
  active boolean not null default true,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index recurring_bills_shop_id_idx on public.recurring_bills(shop_id);
create index recurring_bills_shop_due_idx on public.recurring_bills(shop_id, next_due_date);

-- A spending ceiling per category. One row per category at most -- a second
-- budget for the same category would be two answers to one question.
create table public.budgets (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  category text not null check (category in (
    'inventory_purchase','rent','utilities','salaries_wages','marketing',
    'supplies','transport_delivery','maintenance_repairs','fees_charges',
    'owner_draw','other'
  )),
  limit_cents integer not null check (limit_cents >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (shop_id, category)
);
create index budgets_shop_id_idx on public.budgets(shop_id);

alter table public.cash_accounts enable row level security;
alter table public.recurring_bills enable row level security;
alter table public.budgets enable row level security;

-- One permission across all three: they're a single planning surface with one
-- audience. Splitting view from manage would invent a "can see the shop's cash
-- position but not change it" role that nobody actually needs.
create policy "read cash_accounts" on public.cash_accounts for select using (has_shop_permission(shop_id, 'budgets.manage'));
create policy "write cash_accounts" on public.cash_accounts for all
  using (has_shop_permission(shop_id, 'budgets.manage')) with check (has_shop_permission(shop_id, 'budgets.manage'));

create policy "read recurring_bills" on public.recurring_bills for select using (has_shop_permission(shop_id, 'budgets.manage'));
create policy "write recurring_bills" on public.recurring_bills for all
  using (has_shop_permission(shop_id, 'budgets.manage')) with check (has_shop_permission(shop_id, 'budgets.manage'));

create policy "read budgets" on public.budgets for select using (has_shop_permission(shop_id, 'budgets.manage'));
create policy "write budgets" on public.budgets for all
  using (has_shop_permission(shop_id, 'budgets.manage')) with check (has_shop_permission(shop_id, 'budgets.manage'));

grant select, insert, update, delete on public.cash_accounts to authenticated;
grant select, insert, update, delete on public.recurring_bills to authenticated;
grant select, insert, update, delete on public.budgets to authenticated;

-- "Log this bill": posts the template as a real expense and moves the due date
-- on by one interval, in one transaction so a failure can't leave the bill
-- marked paid without the expense existing (or vice versa).
--
-- Gated on expenses.manage, not budgets.manage, because it creates an expense
-- -- the same reasoning that makes posting a pay run require it. Someone who
-- can plan bills but not record spending can set the schedule up; posting is a
-- separate act.
--
-- The row is locked first so two taps on "Log this bill" can't both read the
-- same next_due_date and post the cost twice.
create or replace function public.log_recurring_bill(p_bill_id uuid, p_occurred_on date default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_bill public.recurring_bills%rowtype;
  v_expense_id uuid;
  v_interval interval;
begin
  select * into v_bill from public.recurring_bills where id = p_bill_id for update;
  if v_bill.id is null then
    raise exception 'recurring bill % not found', p_bill_id;
  end if;
  if not public.has_shop_permission(v_bill.shop_id, 'expenses.manage') then
    raise exception 'not authorized to log expenses for shop %', v_bill.shop_id;
  end if;

  insert into public.expenses (shop_id, occurred_on, amount_cents, category, vendor_id, payment_method, note, created_by)
    values (
      v_bill.shop_id,
      -- Defaults to the date the bill was due, not today: logging last week's
      -- rent a few days late shouldn't move the cost into this week.
      coalesce(p_occurred_on, v_bill.next_due_date),
      v_bill.amount_cents,
      v_bill.category,
      v_bill.vendor_id,
      v_bill.payment_method,
      v_bill.name,
      auth.uid()
    )
    returning id into v_expense_id;

  v_interval := case v_bill.frequency
    when 'weekly' then interval '7 days'
    when 'biweekly' then interval '14 days'
    when 'monthly' then interval '1 month'
    when 'quarterly' then interval '3 months'
    else interval '1 year'
  end;

  update public.recurring_bills
    set next_due_date = next_due_date + v_interval, updated_at = now()
    where id = p_bill_id;

  return v_expense_id;
end;
$$;

grant execute on function public.log_recurring_bill(uuid, date) to authenticated;

-- Manager is "everything except settings and staff management" (0020/0024).
-- Guarded so re-running is a no-op and a customised role isn't overwritten.
update public.roles
  set permissions = permissions || array['budgets.manage']
  where name = 'Manager'
    and permissions @> array['sales.edit', 'dashboard.view']
    and not permissions && array['budgets.manage'];
