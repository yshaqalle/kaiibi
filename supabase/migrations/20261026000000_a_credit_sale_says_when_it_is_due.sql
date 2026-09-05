-- A credit sale says when it comes back.
--
-- Until now a sale on account had an age and no deadline. The receivables tab
-- could say Amina has owed $1,240 for thirty-four days, but not whether
-- thirty-four days was LATE -- nothing had ever said when it was due. The
-- aging strip therefore measured "days since the sale", which is the classical
-- meaning of an aging schedule and was the only measurement available.
--
-- This adds the missing half: a due date on every sale, defaulted from a
-- shop-wide term, stamped by the database.

-- ── The shop's policy ─────────────────────────────────────────────────────
--
-- One column, because the term is shop policy rather than a per-sale
-- negotiation. Thirty days is the default every market kaiibi serves already
-- works to.
--
-- The check is deliberately wider than the Settings stepper (7-90): the
-- stepper is a UI convenience and the constraint is the actual rule, so a
-- shop that genuinely sells on collection (0) or on a long seasonal term is
-- not refused by an arbitrary limit that only ever existed to keep a control
-- tidy. 365 is the outer bound because past a year this stops being a payment
-- term and starts being a bad debt.
alter table public.shops
  add column if not exists credit_term_days integer not null default 30;

alter table public.shops
  drop constraint if exists shops_credit_term_days_sane;
alter table public.shops
  add constraint shops_credit_term_days_sane check (credit_term_days between 0 and 365);

-- ── The date itself ───────────────────────────────────────────────────────
--
-- `due_on`, not `due_at`: a payment term is counted in whole days, and the
-- shop and the customer both think of it as a date on a calendar rather than
-- an instant. This is also already the name the same concept carries on
-- public.invoices (20260804000300), so both sides of the ledger -- what the
-- shop owes and what it is owed -- use one word for one idea.
--
-- Nullable in the column so the trigger below has something to fill. In
-- practice no row stays null: the trigger stamps every insert, and the
-- backfill at the bottom stamps everything that predates it.
alter table public.sales
  add column if not exists due_on date;

-- ── Stamping it ───────────────────────────────────────────────────────────
--
-- A BEFORE INSERT trigger rather than an edit to complete_sale.
--
-- complete_sale is a ~400-line security-definer function that is reproduced
-- VERBATIM in every migration that touches it -- nineteen times so far -- and
-- this repo has already lost an edit that way (the loyalty maturation guard,
-- unenforced for four migrations, see 20260908000300). Adding two lines to it
-- would mean a twentieth full copy and a twentieth chance to drop something
-- unrelated.
--
-- A trigger is also the stronger guarantee. The term is shop policy, so the
-- DATABASE applying it means no write path can forget: complete_sale,
-- edit_sale, an import, a fixture, or whatever writes sales next year. And
-- `sales` already carries two before-insert triggers (sales_monthly_limit in
-- 20260818000300, sales_module in 20260818000400), so this is the established
-- pattern here rather than a new mechanism.
--
-- IT ONLY FILLS A NULL. That is what keeps the per-sale override working: the
-- till sends an explicit due_on when the cashier changed it, and the trigger
-- leaves it alone. Nothing here can overwrite a date a human chose.
--
-- WHY THE SHOP'S LOCAL DATE. `now()::date` resolves in the database session's
-- timezone -- UTC on Supabase. Somalia is UTC+3, so a sale rung up at 21:00
-- local is 18:00 UTC the same day, but one rung up at 01:30 local on the 1st
-- is 22:30 UTC on the LAST day of the previous month -- and a 30-day term
-- counted from that lands a day early. public.shop_local_date
-- (20260908000320) already exists for exactly this and is the one place that
-- has to change when kaiibi sells outside UTC+3.
--
-- Security definer to read public.shops: the insert may arrive from a
-- security-invoker path where the caller's RLS on shops is not guaranteed to
-- expose the row, and a trigger that silently leaves due_on null because it
-- could not see the term would be the exact silent failure this is meant to
-- prevent. It reads one integer from one row and writes nothing.
create or replace function public.stamp_sale_due_on()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_term integer;
begin
  if new.due_on is not null then
    return new;
  end if;

  select s.credit_term_days into v_term from public.shops s where s.id = new.shop_id;

  -- A sale for a shop that does not exist is not this trigger's problem to
  -- report -- the foreign key will refuse the row a moment later with a far
  -- better message than anything raised here. Falling back to the column
  -- default keeps that the FK's error rather than ours.
  new.due_on := public.shop_local_date(coalesce(new.created_at, now())) + coalesce(v_term, 30);
  return new;
end;
$$;

drop trigger if exists sales_stamp_due_on on public.sales;
-- Runs before the two existing before-insert triggers have any bearing on it:
-- they raise or return unchanged, and neither reads due_on. Order does not
-- matter here, so the name is left to sort where it sorts.
create trigger sales_stamp_due_on before insert on public.sales
  for each row execute function public.stamp_sale_due_on();

-- ── The sales that predate all this ───────────────────────────────────────
--
-- Every unsettled sale gets created_at + 30, so the aging column measures ONE
-- thing from the day this ships.
--
-- The alternative -- age from the due date where there is one and the sale
-- date otherwise -- was considered and declined. It puts two different
-- measurements in one bucket, which is precisely the failure the aging work
-- (20260908*, src/lib/aging.ts) went out of its way to avoid: a strip whose
-- tiles each mean something slightly different is a strip nobody can act on.
--
-- 30 rather than the shop's own credit_term_days: the shop's term is a
-- statement about what it does NOW, and applying today's policy backwards
-- claims these customers agreed to a term that did not exist when they bought.
-- 30 is the platform default and is admitted as derived rather than agreed --
-- the receivables tab carries a `context` caveat saying exactly that.
--
-- Settled sales are deliberately left null. They are not on any list this
-- feeds, and inventing a deadline for a debt that was already paid would be
-- fabricating a fact about history to no one's benefit. Going forward the
-- trigger stamps every sale including cash ones, where the date is harmless
-- and simply never read.
update public.sales
   set due_on = public.shop_local_date(created_at) + 30
 where due_on is null
   and settled_at is null;

-- ── The receivables list can see it ───────────────────────────────────────
--
-- Reproduced IN FULL from 20260908001400_owed_is_net_of_the_cash_refunded.sql,
-- which is its newest definition. ONE change: s.due_on is added to the select
-- list. The owed_cents arithmetic, the cash term in both the projection and
-- the WHERE clause, and the settled/customer predicates are carried over
-- untouched.
--
-- The grain stays one row per unsettled SALE. That is deliberate and it is
-- what makes the client's job easy: "the earliest due date this customer has"
-- is then a grouping concern in src/lib/receivables.ts, next to the existing
-- oldest-sale grouping, rather than a second query with its own idea of what
-- counts as outstanding.
--
-- due_on IS APPENDED AT THE END, not placed next to sale_created_at where it
-- reads better. `create or replace view` can only add columns after the
-- existing ones -- inserting one mid-list is interpreted as RENAMING every
-- column after it, and Postgres refuses with "cannot change name of view
-- column total_cents to due_on". The alternative is dropping and recreating
-- the view, which would need every dependent object rebuilt in the same
-- migration for the sake of column order nobody reads: src/lib/balances.ts
-- selects '*' and maps by name. Leave it at the end.
create or replace view public.customer_balances
with (security_invoker = on) as
select
  s.shop_id,
  s.customer_id,
  coalesce(
    nullif(btrim(c.first_name || ' ' || coalesce(c.last_name, '')), ''),
    s.customer_name
  ) as customer_name,
  s.id as sale_id,
  s.created_at as sale_created_at,
  s.total_cents,
  coalesce(paid.total, 0)::integer as paid_cents,
  coalesce(returned.goods, 0)::integer as refunded_cents,
  (s.total_cents - coalesce(returned.goods, 0) - coalesce(paid.total, 0)
     + coalesce(returned.cash, 0))::integer as owed_cents,
  s.due_on
from public.sales s
left join public.customers c on c.id = s.customer_id
left join lateral (
  select sum(p.amount_cents) as total from public.sale_payments p where p.sale_id = s.id
) paid on true
left join lateral (
  select sum(r.goods_cents) as goods, sum(r.total_cents) as cash
    from public.refunds r where r.sale_id = s.id
) returned on true
where s.settled_at is null
  and s.customer_id is not null
  -- The same expression, and it has to be. Without the cash term here a sale
  -- half-paid and half-returned -- 6300 rung up, 3150 paid, 3150 of goods back
  -- and 3150 handed over -- computes to exactly 0 and DISAPPEARS from the
  -- receivables list entirely, owing 3150.
  and (s.total_cents - coalesce(returned.goods, 0) - coalesce(paid.total, 0)
         + coalesce(returned.cash, 0)) > 0;

grant select on public.customer_balances to authenticated;
