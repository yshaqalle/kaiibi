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
