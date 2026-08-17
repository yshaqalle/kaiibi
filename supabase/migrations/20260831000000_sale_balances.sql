-- What a customer still owes on a sale.
--
-- A balance is arithmetic, not a second ledger: what the sale came to, less
-- what came back over the counter, less what has been taken against it.
-- Storing it as a column would mean every payment had to write two places and
-- could disagree with itself -- and the disagreement would be invisible until
-- someone chased a customer for money they had already handed over.

-- ---------------------------------------------------------------------------
-- Columns
-- ---------------------------------------------------------------------------

-- Which till took a payment. Nullable, and `set null` on delete, matching
-- sales.register_session_id and refunds.register_session_id (20260822000000):
-- a shop that never opens a register keeps working exactly as it does today,
-- and retiring a session must not erase the money it took.
--
-- This matters more here than on `sales`, because a balance is settled at a
-- DIFFERENT till, on a different day, from the one that rang the sale up. The
-- session on the sale answers "where was this sold"; this answers "whose
-- drawer is this cash in", and after today those are two different questions.
alter table public.sale_payments
  add column if not exists register_session_id uuid references public.register_sessions(id) on delete set null;

create index if not exists sale_payments_register_session_idx
  on public.sale_payments(register_session_id) where register_session_id is not null;

-- Stamped when the last of a sale's money arrives. Null while anything is
-- still owed, which is what makes "who owes me" a partial-index scan rather
-- than a sum over every payment row in the shop's history.
alter table public.sales
  add column if not exists settled_at timestamptz;

-- Every sale that already exists was paid in full -- complete_sale refused
-- anything else until the migration after this one -- so without a backfill
-- the entire history reads as outstanding the moment the column appears.
--
-- Written as "stamp what the payments actually cover" rather than "stamp
-- everything that exists today" so it stays true if it is ever re-run, and so
-- it is checkable against the rows instead of against a claim about them.
update public.sales s set settled_at = s.created_at
where s.settled_at is null
  and coalesce((select sum(p.amount_cents) from public.sale_payments p where p.sale_id = s.id), 0)
      >= s.total_cents;

create index if not exists sales_unsettled_idx
  on public.sales (shop_id, customer_id)
  where settled_at is null;

-- ---------------------------------------------------------------------------
-- The read access the arithmetic needs
-- ---------------------------------------------------------------------------

-- A balance is computed across three tables, and RLS filters rows rather than
-- raising. So a role that can read a sale's TOTAL but not its PAYMENTS does not
-- get an error from the view below -- it gets `owed = total` on a sale that was
-- paid in full, and goes and asks the customer for the money again.
--
-- That role exists: 20260802030100 widened `read sales` and `read sale_items`
-- to `customers.view` ("a role granting only customers.view is now a realistic
-- shape") and left sale_payments and refunds behind. These two policies
-- reproduce those bodies exactly, with the same key appended, so the rule is
-- the simple one: whoever can see what a sale came to can see what has been
-- paid and returned against it.
--
-- refund_items is deliberately NOT widened. Nothing here reads it, and the
-- line-level breakdown of what a customer returned is more than a receivables
-- list needs.
drop policy "read sale_payments" on public.sale_payments;
create policy "read sale_payments" on public.sale_payments for select
  using (exists (
    select 1 from public.sales s where s.id = sale_id
      and has_any_shop_permission(s.shop_id, array['sales.view', 'dashboard.view', 'customers.view'])
  ));

drop policy "read refunds" on public.refunds;
create policy "read refunds" on public.refunds for select
  using (exists (
    select 1 from public.sales s where s.id = sale_id
      and has_any_shop_permission(s.shop_id, array['sales.view', 'dashboard.view', 'customers.view'])
  ));

-- ---------------------------------------------------------------------------
-- The view
-- ---------------------------------------------------------------------------

-- Lateral subqueries rather than two left joins: joining both payments and
-- refunds multiplies the rows against each other, so a sale with two payments
-- and one refund counts the refund twice. The sums come out wrong in a way that
-- looks entirely plausible on a sale with one of each, which is what every test
-- fixture has.
create or replace view public.customer_balances
with (security_invoker = on) as
select
  s.shop_id,
  s.customer_id,
  -- Left join, not inner: `read customers` needs customers.view / pos.access /
  -- sales.edit, so an accountant holding only sales.view would otherwise have
  -- every row dropped from under them. They fall back to the name the sale
  -- itself recorded, which is the name on the receipt anyway.
  coalesce(
    nullif(btrim(c.first_name || ' ' || coalesce(c.last_name, '')), ''),
    s.customer_name
  ) as customer_name,
  s.id as sale_id,
  s.created_at as sale_created_at,
  s.total_cents,
  coalesce(paid.total, 0)::integer as paid_cents,
  coalesce(returned.total, 0)::integer as refunded_cents,
  (s.total_cents - coalesce(returned.total, 0) - coalesce(paid.total, 0))::integer as owed_cents
from public.sales s
left join public.customers c on c.id = s.customer_id
left join lateral (
  select sum(p.amount_cents) as total from public.sale_payments p where p.sale_id = s.id
) paid on true
left join lateral (
  -- Goods that came back are not a debt. Without this a returned basket keeps
  -- appearing on the customer's account and the shop chases money it was never
  -- owed.
  select sum(r.total_cents) as total from public.refunds r where r.sale_id = s.id
) returned on true
where s.settled_at is null
  -- No name, no debt. An unpaid sale with nobody attached is a loss to be
  -- written off, not a receivable to be collected.
  and s.customer_id is not null
  and (s.total_cents - coalesce(returned.total, 0) - coalesce(paid.total, 0)) > 0;

-- security_invoker means the view carries no privilege of its own: it sees
-- exactly the sales, payments and refunds the caller could already read.
grant select on public.customer_balances to authenticated;
