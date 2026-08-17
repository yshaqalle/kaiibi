# Database tests

Checks that can only be made against a real Postgres: triggers, RLS policies,
and `security definer` RPCs. The TypeScript suite (`npm test`) covers the pure
arithmetic; this covers the parts the database itself enforces.

## Running

```bash
supabase start                 # first run pulls images, takes a few minutes
supabase db reset              # applies every migration from scratch
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
  -f supabase/tests/verify-accounting-writes.sql
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
  -f supabase/tests/verify-entitlements.sql
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
  -f supabase/tests/verify-platform-portal.sql
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
  -f supabase/tests/verify-loyalty.sql
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
  -f supabase/tests/verify-refunds.sql
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
  -f supabase/tests/verify-balances.sql
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
  -f supabase/tests/verify-owner-membership.sql
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
  -f supabase/tests/verify-support.sql
```

Look for `ALL CHECKS PASSED`. Any failure raises and stops the script.

`supabase db reset` is itself worth running: it proves the whole migration
chain still applies to an empty database, which pushing incrementally to a
long-lived project never checks.

## Safety

Run against the **local** database, not production. The script creates a
throwaway shop, staff member, bill and pay run, then deliberately raises at
the end so its enclosing block rolls everything back — it leaves no rows
behind, verified by counting afterwards. It would nonetheless be a poor idea
to point it at real data.

## What `verify-accounting-writes.sql` covers

1. Recording a vendor bill posts one linked expense, dated the **issue date**
   rather than today.
2. Editing the bill keeps that expense in step.
3. A bill-generated expense can't be edited or deleted directly — with a
   control proving an ordinary hand-entered expense still can, so the guard
   isn't just blocking everything.
4. Paying a bill moves its balance and **leaves the expense alone** (the cost
   was recognised when the bill was raised — this is the check that accrual
   isn't double-counting). Overpayment is rejected.
5. Posting a pay run writes one `salaries_wages` expense dated **period end**;
   posting twice is rejected; a line that warns of a missing pay rate and has
   no amount is rejected but posts once an amount is entered — and keeps its
   warning; an overlapping period is **accepted** for a different member and
   **rejected** for the same one, naming them; unposting removes the expense
   and returns the run to draft.
6. Logging a recurring bill posts an expense dated the **due date** and
   advances the schedule by one interval.
7. `sale_items.unit_cost_cents` exists, so COGS reads a frozen cost rather
   than the product's current one.

Dates are asserted explicitly because they're the easiest thing to get subtly
wrong: posting August's payroll in September must land the cost in August, or
both months are misstated.

## What `verify-entitlements.sql` covers

1. Creating a shop starts a **trial** granting every module and no caps.
2. A lapsed trial resolves to **expired** and falls back to the Free plan —
   losing accounting, **keeping POS**, so a shop can still run its till.
3. `grace_until` keeps the **paid** plan, because mobile-money payment is
   confirmed by hand and a shop that paid yesterday must not be locked out
   today.
4. A paid `current_period_end` reads as **active** even though the trial date
   is long past.
5. The **store cap** refuses a second location on Free — and the existing one
   stays fully editable, because a downgrade freezes growth and never takes
   away what a shop already has.
6. A limit of **zero** (Free grants `vendors: 0`) blocks everything.
7. Counters track **deletes**: removing a product frees a slot that is
   genuinely reusable.
8. **Override precedence** — a limit override beats the plan, a module override
   grants, and an *expired* override stops granting.
9. `manual_status = 'suspended'` strips every module whatever the plan says.
10. **An expired shop can still read all its own data.** This is the check that
    catches someone "tidying up" by adding a module gate to a SELECT policy.
11. A shop with **no subscription row at all** fails closed to Free, never open.
12. `my_shop_entitlements()` returns status, plan and live usage.

## What `verify-platform-portal.sql` covers

Written as "the attacker got this far, and then could not", because that is the
question being asked of a back office that can see every customer.

1. An operator at **aal1** (password only, no second factor) fails
   `is_platform_admin()` and reads **zero** rows. A stolen password is worth
   nothing on its own.
2. `is_platform_admin_pending_mfa()` still recognises them, so the portal can
   tell "you don't work here" from "finish signing in" instead of offering a
   dead end.
3. At **aal2** the same operator reads subscriptions, shops and usage.
4. …and **still cannot read `products`, `sales`, `customers`, `expenses`,
   `shifts`, or `shop_members`.** If any of those ever returns rows, someone
   widened a policy that should have stayed narrow — this is the blast radius of
   a compromised operator account.
5. An operator **cannot** update a subscription directly from a client session
   (every mutation must go through the audited edge function), **cannot** forge
   or delete an audit row, and **cannot** appoint another operator.
6. A shop owner cannot enumerate our operators or read the audit log, and still
   sees exactly their own shop — so the operator policies widened nothing for
   ordinary users.

## What `verify-loyalty.sql` covers

1. Loyalty off earns nothing and writes no ledger rows, even with a customer
   attached.
2. A $19.99 basket earns **19** points, not 20 — the floor case that makes "a
   point for every dollar spent" literally true — and the earn rate is
   snapshotted onto the sale.
3. Turning tax on does **not** change what a sale earns: points are earned on
   the goods, not on money collected for the state.
4. A redemption comes off before tax; paying the un-reduced total is refused;
   it stays out of `discount_cents`; and one sale writes **two** ledger rows
   ("spent 38, earned 19"), never one net row.
5. Redeeming more than the balance raises, and the balance is unchanged. This
   is also the cross-register double-spend guard.
6. **`customers.points_balance` equals `sum(customer_points_ledger.delta_points)`**
   — re-checked after every step. If the counter and the ledger ever drift,
   every other number here is meaningless.
7. Refunding 1 of 3 units claws back `floor(59/3)`; refunding the other 2
   brings the cumulative clawback to exactly the 59 earned, with no drift from
   having done it in two passes.
8. A full refund returns the redeemed points once, and only once.
9. Editing a sale keeps its redemption (or the recomputed total jumps and the
   payments check rejects an edit that changed nothing) and re-earns at the
   sale's **frozen** rate rather than the shop's current one — deliberately
   unlike tax, which `edit_sale` re-reads.
10. `delete_sale` posts reversing rows before deleting, so a voided sale's
    points don't count forever.
11. **Earned points cannot be spent until they have matured.** Redeeming
    same-day points is refused and names what is still on hold; aging the ledger
    rows past the window makes the whole balance spendable.
12. **A clawback never drives the balance negative.** Earn on one sale, spend it
    all on another, return the first — the shop absorbs what it cannot recover
    rather than posting the customer a debt.
13. **A refund gives points back before it takes them away.** The ordering
    check: reversing the two lets the clawback hit an emptied balance, get
    clamped to nothing, and the reversal then hand back points the shop meant to
    reclaim. Asserts the exact net, which is what distinguishes the two orders.
14. **A shop whose plan has lapsed can still complete a sale** with a customer
    attached, earning nothing. This is the regression that matters most:
    `public.customers` carries `enforce_shop_module('customers')` as a BEFORE
    UPDATE trigger, and `security definer` does not bypass a trigger — without
    the `shop_has_module()` gate inside `complete_sale`, a shop that stopped
    paying could no longer ring up anything at all.

## What `verify-refunds.sql` covers

One question asked against every kind of pricing a sale can carry: **does
refunding the whole thing return exactly what the customer paid?** Until
20260820000200 the answer was no whenever a sale had an order discount, a points
redemption, or tax, because refunds apportioned `line_total_cents`, which knows
about none of the three.

1. A plain sale refunds its price.
2. An **order discount** is not handed back a second time — 1799 refunded on
   1999 of goods with 200 off, where the old maths returned the full 1999.
3. **Tax comes back**, so the customer isn't short the tax they paid.
4. Points redeemed are **not** converted into a cash refund.
5. All three at once, returned one unit at a time, sum to exactly what was
   paid — the check that catches rounding drift in the scaling.
6. `refund_items` still sum to their `refunds` row after the scaling rewrites
   the child amounts.
7. A fourth unit can't be refunded from a three-unit sale.

Note the deliberate limit: the paid-equals-refunded guarantee holds for sales
refunded entirely **after** that migration. Prior refunds are read from the
stored rows and never recomputed, so an old partial refund is never silently
"corrected" months later.

## What `verify-balances.sql` covers

`customer_balances` computes one number across three tables, which makes it
wrong in two directions that both look fine. Neither raises; both send someone
to ask a customer for money already handed over, so both are asserted on exact
cents.

1. A sale paid in full is not a balance.
2. A part-paid sale owes **exactly** the shortfall.
3. Goods that come back are not a debt — returning one unit of three drops the
   debt by that unit, and returning the rest removes the row entirely. A refund
   on an unpaid sale hands back no cash, because none was ever taken.
4. **Two payments and one refund do not multiply.** Joined directly rather than
   through lateral subqueries, two payment rows against one refund row give a
   two-row cross product and the refund is counted twice. Every fixture with one
   payment and one refund passes anyway, which is why this one has two.
5. No name, no debt: an unpaid sale with nobody attached is a loss to write off,
   not a receivable to chase.
6. **A role holding only `customers.view` reads the true figure.** 20260802030100
   widened `sales` and `sale_items` to that key and left `sale_payments` and
   `refunds` behind, so before 20260831000000 this role read `owed = total` on a
   sale that was paid off — measured at **4000 owed on a sale owing 500**, with
   no error, on the exact screen used to ring that customer up.
7. Another shop reads nothing.

Then the credit rules themselves, once `complete_sale` can accept a shortfall:

8. **A shortfall nobody asked for is still refused.** The guard is not removed,
   only made conditional — the call that failed before this migration fails the
   same way after it.
9. Over-payment is refused however it is asked for. `p_allow_balance` does not
   become a way past it: change is `tendered_cents`, not a larger payment.
10. Credit needs a name, refused by the server rather than discouraged by the UI.
11. Asked for, against a name: the sale stands, owes the shortfall, and is not
    stamped settled.
12. Paying in full stamps `settled_at` even when credit was offered, or the sale
    stays on the receivables list forever.
13. Settling in two instalments — the RPC's return and the view agree at each
    step, and the last payment stamps the sale and clears the row.
14. A settlement cannot overshoot what is owed, or repeat on a paid sale.
15. **Editing a sale does not erase a settlement.** `edit_sale` deletes a sale's
    payments and re-inserts what the client sent — lossless while every payment
    arrived at the till in one go, destructive the moment money can arrive days
    later. Reverting that one `where` clause drops the settlement row entirely
    and puts the customer back in debt for cash they had already handed over.
16. A settlement will not go into a closed drawer — the same refusal
    `complete_sale` makes, arriving by a new road.
17. Reading a balance is not permission to take money: the `customers.view` role
    from check 6 can see what is owed and cannot record a payment.

And loyalty, which is where credit turns into a way to take value out of a shop
without paying for it:

18. **Goods on account earn no points until paid.** Otherwise the loop is: buy on
    account, earn, spend the points on a second basket, never settle the first.
    The sale still remembers the rate it will earn at.
19. Settling earns them **at the sale's own frozen rate**, not the rate the shop
    offers on the day the money arrives — asserted by moving the shop's rate
    between the sale and the settlement. A part-settlement earns nothing, and
    `customers.points_balance` still equals the ledger afterwards.
20. **Paying in full at the till still earns immediately** — the regression that
    matters most, because that is every sale this shop has ever taken.
21. A sale returned against **before** it was settled earns nothing at all.
    Proportioning it would have to agree with the refund clawback's own
    proportioning against a base it does not share.

## What `verify-owner-membership.sql` covers

The owner of a shop had no `shop_members` row — adminship was `shops.owner_id`
and nothing else. `shifts.shop_member_id` and `registers.shop_member_id` are
foreign keys into that table, so there was nothing to point at: the owner could
not be scheduled or handed a till, which is most of the People feature in a
one-person shop. Migration 20260823000000 gives them an ordinary row.

1. A new shop seeds `Cashier`, `Manager` and `Owner` — nothing had seeded roles
   since 0020, so a shop created after it had none at all.
2. It seeds exactly one active owner membership, named from the profile (or the
   signup metadata, since the shop can exist before the profile row does), on
   the `Owner` role, assigned to no store and therefore to all of them.
3. The owner occupies a staff seat like anyone else.
4. Free still fits the owner **plus two employees** — which is why its cap went
   2 → 3, and Standard's 10 → 11. The seat after that is still refused.
5. The owner cannot be deactivated or deleted, but their *role* can still be
   changed: it is a label, and `user_has_shop_permission()` answers true for an
   owner before it ever reads one.
6. Deleting a shop still cascades through that guard rather than tripping it.
7. **The owner can be given a shift** — the question the whole migration exists
   to answer.

## What `verify-support.sql` covers

Support threads are the one place a member writes to us rather than to their
shop, so the read policy is per-author instead of per-shop. The cashier in this
script is a real `shop_members` row on the seeded Cashier role — a stranger
would pass 6 and 8 for the wrong reason. There is a second, non-owner member
for the same kind of reason: `user_has_shop_permission()` answers true for an
owner before it reads a role, so a permission branch asserted only through the
owner is never actually consulted.

1. `KB-####` references are unique and increasing.
2. A thread defaults to open with a reference.
3. Posting a message advances `last_message_at` and marks the thread read for
   the end that wrote it and **only** that end — the asymmetry the unread count
   is built on.
4. **A cashier's message to us is invisible to the shop owner.** The question
   the whole policy exists to answer: a staff member reporting their manager
   must not be reporting them to their manager.
5. The author still reads their own.
6. A thread *we* address to the store reaches `settings.access` holders and not
   the cashier — billing belongs to whoever runs the shop. Asserted through a
   Manager who is refused, granted `settings.access`, and then admitted with
   nothing else about them changing, so it is the permission deciding.
7. A member of another shop reads nothing.
8. A member cannot insert a thread claiming `opened_by = 'platform'`, which
   would otherwise let them borrow the wider read policy that grant carries —
   with a control opening an ordinary thread and replying to it, both with
   `RETURNING`. That control is not decoration: `insert … returning` runs the
   select policy against a row no snapshot can see yet, so a visibility rule
   written as a lookup by id refuses every create the client makes.
9. A member cannot write the columns only we set. A with-check policy
   constrains the columns it names and nothing else, so `reference`, `status`,
   the read stamps and `created_at` are held back by **column-level** insert
   grants instead. Plus the trigger's own half: a message inserted with a
   three-year-old `created_at` still sorts as arriving now, rather than sinking
   its thread to the bottom of the operator's queue.
10. **An uploaded file is exactly as private as the thread it is on.** Check 4
    for storage: the cashier uploads to `<shop_id>/<thread_id>/`, and the owner
    can neither list it, read it, nor delete it — with the store-addressed
    thread as the control proving the owner is not simply locked out of the
    bucket. The cashier also cannot *write* into that thread's folder: shop-wide
    upload against thread-scoped read would let them hand the owner a file from
    someone with no access to the conversation. And two malformed objects are
    seeded first — a `product-images` staff photo (`<shop_id>/staff/<file>`) and
    one written as `postgres` inside `support-attachments` itself — because
    `storage.objects` is one table for every bucket and a policy that casts a
    path segment to uuid takes every listing in the project down with it the
    first time it meets a segment that isn't one. Both are asserted by path
    rather than by a row count, which any bucket's public policy would satisfy.
11. An attachment row cannot name a file outside its own thread's folder, on
    update as well as insert. Storage RLS stops the member downloading it, but
    an operator renders the thread through `service_role`, which bypasses
    storage RLS entirely.

## Concurrency

The limit triggers take a `select … for update` on the counter row, which is
what makes a cap *exact* rather than usually-right. To see that directly, run
two `psql` sessions inserting the boundary-th record at the same moment:
exactly one succeeds, and the counter matches the real row count afterwards.
