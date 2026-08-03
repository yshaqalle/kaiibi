# Payroll draft warnings — design

**Date:** 2026-08-03
**Status:** Approved, ready for planning
**Scope:** Spec 1b-pre of the payroll sequence (see "Sequence" below)

## Problem

`computePayrollDraft` computes a `warning` for every line that needs a human
decision, and then the warning is thrown away.

`PayrollDraftLine.warning` has no runtime consumer anywhere in the app:

- `createPayrollRun` (`src/lib/payroll.ts:70-83`) does not persist it.
- `payroll_run_lines` has no column to hold it.
- `PayrollRunLine` (`src/types/models.ts:499`) has no such field.
- `PayrollRunEditor` renders nothing for it.

`grep -rn warning` across `payroll-run-editor.tsx`, `payroll.ts`, and
`models.ts` returns no hits. The only readers are unit tests.

This makes a comment in `payroll-reporting.ts:16-18` false:

```ts
// Set when the figure needs a human decision rather than being wrong --
// surfaced in the editor so it's corrected before posting, not after.
```

It is not surfaced anywhere. Three conditions currently produce a warning, and
all three post silently:

| Condition | Amount produced | Consequence |
|---|---|---|
| No pay rate set | **0** | A real person is paid nothing, posted to the P&L as fact |
| N shifts still clocked in | Undercounts hours | Underpayment |
| Prorated for N days | Approximate | Often correct; sometimes not |

## Why this ships before the cadence work

The cadence spec (per-member `pay_cadence`, pay-period generation) multiplies
the number of approximate and edge-case figures: partial first periods, a
cadence changed mid-cycle, a missing pay-period anchor. Every one of those
resolves to a warning. Building that on top of a warning channel nobody can see
means each new edge case fails as silently as today's do.

This spec is small — two columns, persisting a field that is already computed,
and rendering it — and it makes everything after it observable.

## Decisions

### Warnings carry a severity

The three warnings are not equally serious. A $0 line is a different kind of
thing from an approximate one.

- **Blocking** — `No pay rate set`. Produces a zero amount, which pays a real
  person nothing.
- **Advisory** — the clocked-in and prorated warnings. Displayed, never block.

Rejected alternatives:

- **Advisory only**: leaves the zero-pay case exactly as silently postable as
  it is today.
- **Everything blocks until acknowledged**: puts friction on the common,
  usually-correct proration case. Friction that fires constantly gets clicked
  through without reading, which is worse than no warning — it manufactures
  false confidence.

### The block tests the amount, not the warning

`post_payroll_run` rejects a line that is `warning_blocking AND amount_cents = 0`.

This is deliberately not "reject if a blocking warning exists". A blocking
warning must be clearable by typing an amount, because that is what the run
editor is for — the payroll migration states the rationale directly
(`20260804000400_payroll.sql:14-18`): "proration for a mid-period joiner, a
bonus, a deduction... letting a human adjust the computed figure before
committing is how payroll actually works." Forcing someone back to People to
set a permanent pay rate is wrong for a one-off contractor or an ad-hoc amount.

Testing the amount rather than mutating the warning also means the line keeps
"this was drafted with no pay rate" as permanent audit history. Resolution
without restatement — the same principle that already governs the frozen
`pay_type` / `pay_rate_cents` columns.

### Warnings are frozen, not recomputed

The warning is written at draft time and never recalculated. Recomputing at
display time would let a later pay-rate change alter what a past run appears to
have warned about, which is the exact restatement the frozen columns exist to
prevent.

### Not folded into `note`

`payroll_run_lines.note` is user-editable. Writing a system warning into it
means a human edit silently destroys the warning, and there is no way to tell
the two apart afterwards.

## Architecture

### Migration

```sql
alter table public.payroll_run_lines
  add column warning text null,
  add column warning_blocking boolean not null default false;
```

Both nullable/defaulted, so existing rows are unaffected — an already-posted
run keeps `warning_blocking = false` and stays postable/unpostable exactly as
before.

### `post_payroll_run`

Recreated in full (matching the file's existing convention) with one new guard,
placed **after** the overlap check and **before** the `v_total <= 0` check:

```sql
select string_agg(coalesce(member_name, 'A staff member'), ', ')
  into v_blocked_names
  from public.payroll_run_lines
  where payroll_run_id = p_run_id
    and warning_blocking
    and amount_cents = 0;
if v_blocked_names is not null then
  raise exception 'no amount set for % — enter an amount, or set a pay rate in People', v_blocked_names;
end if;
```

The error names the people, not the period. A period range is not actionable;
a name is. This follows the same correction planned for the overlap guard's
error message in the cadence spec.

Ordering matters: this guard sits before the `v_total <= 0` check because a run
whose only lines are blocking-and-zero would trip both, and "no amount set for
Hodan Ali" is a better message than "this pay run has nothing to pay".

### Types

`PayrollDraftLine` already has `warning: string | null`. It gains
`warningBlocking: boolean`. `PayrollRunLine` gains both fields. `mapLineRow`
in `payroll.ts` maps them; `createPayrollRun` persists them in its insert.

### Severity assignment

In `computePayrollDraft`, the `No pay rate set` branch returns
`warningBlocking: true`. Every other branch returns `false`, including the
no-warning cases.

### UI

`PayrollLineRow` (`payroll-run-editor.tsx:137-179`) renders the warning beneath
the existing basis text inside `styles.lineMain`, visually distinct by
severity — blocking in the danger colour already used by `styles.dangerText`,
advisory in a muted tone.

The Post button (`payroll-run-editor.tsx:100-108`) is disabled when any line is
blocking-and-zero, with a line of explanatory text stating which member needs
an amount. It is already disabled on `busy || total <= 0`, so this extends an
existing condition rather than introducing a new control.

## Testing

Unit tests in `src/lib/__tests__/payroll-reporting.test.ts`:

- `No pay rate set` produces `warningBlocking: true`.
- The clocked-in warning produces `warningBlocking: false`.
- The prorated warning produces `warningBlocking: false`.
- A clean line produces `warning: null, warningBlocking: false`.

### The `post_payroll_run` guard is tested too

An earlier draft of this spec claimed the RPC could not be tested here. That
was wrong. `supabase/tests/verify-accounting-writes.sql` is an established
harness for exactly this — checks that "can only be made against a real
Postgres: triggers, RLS policies, and `security definer` RPCs" — and it
**already covers `post_payroll_run`**, asserting that posting writes one
`salaries_wages` expense dated period end, that a double post is rejected, and
that an overlapping period is rejected (`verify-accounting-writes.sql:152-203`).

The new guard is tested in the same file, following its existing shape: build a
run with a blocking-and-zero line, assert `post_payroll_run` raises; set an
amount on that line, assert it then posts. Everything runs inside the one `DO`
block whose `EXCEPTION` clause rolls the lot back, so it leaves no rows behind.

Run with:

```bash
supabase start
supabase db reset
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
  -f supabase/tests/verify-accounting-writes.sql
```

`supabase db reset` is itself part of the value: it proves the whole migration
chain still applies to an empty database, which pushing incrementally never
checks. That is exactly the class of defect that slipped through in spec 1a,
where a migration was timestamped before the table it referenced and would have
broken a fresh reset — caught only by a reviewer reading version numbers.

## Sequence

1. **1a — Pay rate units.** Complete, merged to `db-fixes`, migration applied.
2. **This spec — Draft warnings.** Makes the warning channel visible.
3. **1b — Pay cadence & periods.** Per-member `pay_cadence`, shop-level
   `pay_period_anchor`, pay-period generation, the per-member rework of
   `post_payroll_run`'s overlap guard and the accrual functions, and defaulting
   the pay period to a calendar month.
4. **Staff CSV import round-trip** for the pay columns — `staff-import.ts:69-70`
   nulls `payType`/`payRateCents`, so the CSV that 1a taught to export pay no
   longer re-imports it. Small and independent.
5. **Store hours**, then **team scheduling**.

## Out of scope

- Pay cadence, period generation, the overlap-guard rework, accrual changes —
  the cadence spec.
- New warning conditions. This spec surfaces the three that already exist; it
  does not invent more.
- Acknowledging or dismissing advisory warnings. They display and are ignored
  at the owner's discretion; there is no per-line "reviewed" state, because
  friction that fires on every prorated line would be clicked through without
  being read.
- Backfilling warnings onto existing posted runs. They were drafted without the
  field and are historical; recomputing warnings for them would be exactly the
  restatement this design rejects.
