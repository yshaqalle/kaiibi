-- The shop remembers who it already chased, and in whose words.
--
-- Sits on top of 20261026000000, which gave a credit sale a due date. Knowing
-- who is late is only half of collecting: a shop with fourteen overdue
-- customers also needs to know who it spoke to yesterday, or two staff ring
-- the same person twice and nobody rings the other thirteen.

-- ── When this customer was last reminded ──────────────────────────────────
--
-- On `customers`, not on `sales`, because a reminder is addressed to a PERSON
-- about their whole balance. The receivables list is already one row per
-- customer (groupByCustomer in src/lib/receivables.ts) and the message states
-- one total and one date, so a per-sale stamp would be recording something
-- finer than anything that actually happens.
--
-- A single mutable column rather than a table of reminder events. What the
-- screen needs is "have I chased this person recently", which is one
-- timestamp; a history table would be a second schema, a second RLS policy and
-- a second thing to keep correct in exchange for a question nobody has asked
-- yet. It stays additive -- if a shop ever wants the full log, this column is
-- what a table would be built from, not something it would contradict.
--
-- WHAT IT HONESTLY MEANS, and this matters for how the UI words it: WhatsApp
-- deep links are one-way. We hand the operating system a wa.me URL with the
-- message already written and we are never told what happened next. So this
-- records that the shop OPENED a reminder, not that one was delivered or even
-- sent. The screen says "Reminded 2 days ago" on the shopkeeper's own action,
-- which is true, and deliberately never claims the customer received anything.
alter table public.customers
  add column if not exists last_reminded_at timestamptz;

-- ── The words the shop uses ───────────────────────────────────────────────
--
-- Null means "use the built-in default", which is the whole reason this is
-- nullable rather than a text column seeded with the default string.
--
-- Two things fall out of that. Improving the default wording later reaches
-- every shop that never customised it, instead of only new ones. And "never
-- touched it" stays distinguishable from "typed the default out by hand",
-- which is the difference between a shop that has no opinion and one that
-- agreed with ours.
--
-- The default itself lives in src/lib/reminder.ts, not here. A message body is
-- copy: it belongs where it can be read in the same breath as the code that
-- substitutes into it and tested without a database, and putting it in a
-- migration would mean a migration every time a word changes.
--
-- Deliberately no CHECK on the placeholders. A template with a typo'd
-- {amout} is a message that reads slightly wrong, which the shopkeeper sees
-- in WhatsApp before sending; a constraint that rejects it is a shop unable
-- to save a settings screen and no idea why. src/lib/reminder.ts leaves an
-- unknown placeholder standing in the text rather than silently deleting it,
-- so the mistake is visible instead of invisible.
alter table public.shops
  add column if not exists reminder_template text;

-- ── The collections list can see when it last chased ──────────────────────
--
-- Reproduced IN FULL from 20261026000000 (this migration's immediate
-- predecessor and the view's newest definition). TWO columns appended:
-- c.last_reminded_at and c.phone.
--
-- The view ALREADY left-joins public.customers, for the display name -- so both
-- cost no extra join and, more to the point, no second query. The alternative
-- was fetching customers separately on the receivables tab and stitching the
-- two together on the client, which is a second thing that can fail, a second
-- loading state, and a list that can render debts without their phone numbers
-- for a frame -- during which every reminder button would be hidden, because
-- WhatsAppButton hides itself when it has no dialable number.
--
-- WHY c.phone AND NOT s.customer_phone. `sales` carries a frozen snapshot of
-- the number as it was when the sale was rung up (0023_customers.sql keeps it
-- deliberately unchanged when a customer is later edited). That is the right
-- value for a receipt, which is a record of what happened. It is the wrong
-- value for a reminder, which is an attempt to reach a person TODAY -- so this
-- takes the current number off `customers`.
--
-- Appended at the end for the same reason due_on was: `create or replace view`
-- reads a mid-list insertion as renaming every column after it and refuses.
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
  s.due_on,
  c.last_reminded_at,
  c.phone as customer_phone
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
