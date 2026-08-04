# Payroll follow-ups — design

**Date:** 2026-08-03
**Status:** Approved, ready for planning
**Scope:** Three independent defects left open by the pay-cadence work

## Problem

Three issues, unrelated to each other except that all three came out of the
pay-cadence review.

**A. A mis-set cadence is invisible.** `computePayrollDraft` silently drops any
member whose `payCadence` differs from the run's, and nothing tells the owner
who was dropped. Cadence is not shown on the roster (`people.tsx:663` shows pay
type only; cadence appears solely inside the gated edit form), the create card
shows only chips, and the run list shows a bare "N people". Because
`pay_cadence` backfilled to `'monthly'` on every existing row, a shop that moves
to weekly and misses one member excludes them from every run, indefinitely.
Before cadence existed, every run included every active member, so an omission
was visible on the spot.

**B. The staff CSV no longer round-trips.** `staff-import.ts:69-70` hard-nulls
`payType` and `payRateCents`, and never touches cadence. The export learned to
emit pay in an earlier spec, so exporting a roster and re-importing it now
silently drops every pay field. The export is also incomplete — it has
`Pay Type`, `Pay Rate` and `Pay Rate Unit` but no `Pay Cadence`.

**C. Two concurrent posts can pay someone twice.** `post_payroll_run` takes
`select ... for update` on its own `payroll_runs` row only. Two *different*
overlapping runs sharing a member each lock a different row, neither sees the
other's uncommitted `posted` status, and both succeed. The race is pre-existing,
but it was previously unreachable in practice: the old shop-wide guard rejected
overlapping runs outright. Per-member cadence makes overlapping drafts the
normal operating mode, so the race is now routinely reachable.

## A — Cadence visibility on the draft card

### Design

The create card (`payroll-tab.tsx:142-194`) loads the active roster when it
opens and renders a line beneath the cadence chips:

> This weekly run covers 3 of 7 active staff.

When the count is **zero**, Build draft is disabled and the line names the
problem — nobody is on that cadence.

With **Custom dates** selected the run has no cadence and includes every active
member, so the line says so rather than showing a fraction: "This run covers all
7 active staff." A fraction of 7/7 would imply a filter is being applied when
none is.

### Why the create card

Three surfaces could carry this. The card wins because it puts the information
at the moment of decision: a covered count that does not match the headcount is
noticed there, before a run exists. The roster (People) makes cadence visible
whenever anyone looks at the team, but that is a passive surface someone has to
think to visit. The run list only tells you after the fact.

The roster remains a reasonable later addition; it is not required to close this.

### Second effect, deliberate

Disabling Build draft at zero also closes a separate finding: picking a cadence
nobody is on currently creates a `payroll_runs` row, which then fails to post
with `this pay run has nothing to pay` and must be deleted by hand. Preventing
the empty draft is strictly better than cleaning it up.

### Cost

One `listStaff` call when the card opens. `startRun` already calls `listStaff`;
this moves the knowledge earlier rather than adding a new kind of work.

## B — Staff CSV pay round-trip

### Export

`TEAM_EXPORT_COLUMNS_WITH_PAY` (`people.tsx:62`) gains a `Pay Cadence` column
beside the existing three.

### Import

`runStaffImport` reads `Pay Type`, `Pay Rate` and `Pay Cadence`, and applies
them to each provisioned member.

Four details that decide the shape:

**The exported format already parses.** `toCents` strips everything but digits
and `.`, so the exported `"$3,000.00"` becomes `300000` unchanged. No export
format change is needed for round-tripping, and none is made.

**A salaried `Pay Rate` needs no conversion.** The stored figure is canonically
per month, and that is what the export writes. `Pay Rate Unit` is therefore
informational: it is *validated* against the pay type when present and never
used to convert. A mismatch rejects the row rather than silently reinterpreting
a number.

**Pay lands in a second call.** `provisionStaff` invokes an edge function that
mints an auth user and a roster row and takes no pay fields. Pay is applied
after, via `updateStaffPay`. Import is already sequential and rare, so a second
call per row is acceptable.

**A pay-write failure is reported, not swallowed.** If provisioning succeeds and
the pay write fails, the member *exists*. Reporting them as accepted would hide
a wrong roster; reporting them as a plain rejection would imply nothing was
created and invite a re-import that fails on duplicate email. They are therefore
listed in `rejected` with a reason that says explicitly that the member was
created and only their pay needs setting by hand. `ImportReport` gains no new
field — the shared import machinery is used by customers and products too, and
this case does not justify changing it.

### Gating

Export already branches on `people.payroll.manage` (`people.tsx:489`). Import
takes the same flag and, without it, ignores the pay columns rather than
failing the file — an operator who cannot see pay should not be blocked from
importing names and roles.

## C — Serialise posts within a shop

One statement in `post_payroll_run`, before the existing row lock:

```sql
perform pg_advisory_xact_lock(hashtext('payroll_post:' || v_run.shop_id::text));
```

Shop-scoped, so posts serialise within a shop and never across shops.
Transaction-scoped, so it releases on commit or rollback with no leak path and
nothing to unlock explicitly.

Placed *before* `select ... for update` so that every subsequent guard read —
already-posted, the per-member overlap check, the blocking zero-amount check,
the total — sees the committed state of any concurrent post rather than racing it.

The `comment on function` text, which currently documents this race as a known
limitation, is updated to record that it is closed.

### Testing limit, stated plainly

This cannot be pinned by the existing harness. `verify-accounting-writes.sql`
runs as a single `DO` block in one session, and demonstrating a race needs two.
The change is verified by the existing suite for non-regression plus a manual
two-session check, and is otherwise correct by construction. No automated test
will defend it, and the plan must not pretend otherwise.

## Testing

- **A** — no automated coverage possible; there is no React Native testing
  library in `devDependencies`. Verified by typecheck, lint, and reading. The
  count itself is a `filter().length` over data the existing tests already cover.
- **B** — `runStaffImport` is not currently unit-tested and reaching it means
  stubbing an edge-function call. In scope: a pure helper that maps a CSV row to
  a pay patch (`payType`, `payRateCents`, `payCadence`) or a rejection reason,
  with tests for a valid row, an unknown pay type, an unparseable rate, an
  unknown cadence, a `Pay Rate Unit` contradicting the pay type, and a row with
  no pay columns at all. That is where the logic worth defending lives.
- **C** — `verify-accounting-writes.sql` must still pass green, proving the lock
  breaks nothing on the single-session paths.

## Out of scope

- **Showing cadence on the People roster.** A reasonable later addition; the
  draft card closes the reported problem.
- **Updating existing staff via CSV import.** Import provisions new members only,
  and a duplicate email already rejects. Making it an upsert is a different
  feature.
- **Changing the export's money format** to a raw number. It parses back
  correctly as-is, and a bare number would read worse in a spreadsheet.
- **`ImportReport` gaining a warnings channel.** Shared with customers and
  products; not justified by this one case.
- **Store hours and team scheduling** — still the two large unbuilt features.
