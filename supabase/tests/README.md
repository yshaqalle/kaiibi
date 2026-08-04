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

## Concurrency

The limit triggers take a `select … for update` on the counter row, which is
what makes a cap *exact* rather than usually-right. To see that directly, run
two `psql` sessions inserting the boundary-th record at the same moment:
exactly one succeeds, and the counter matches the real row count afterwards.
