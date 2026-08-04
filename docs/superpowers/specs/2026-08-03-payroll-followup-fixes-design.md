# Payroll follow-up fixes — design

**Date:** 2026-08-03
**Status:** Approved, ready for planning
**Scope:** Five small defects raised by the final review of the payroll follow-ups

## Problem

Five issues, all raised by review rather than by use. None can pay a member
twice or leave one unpaid; they are silent failures, stale reads, and one
hardening change with a deadline.

## A — Namespace the advisory lock key, before it ships

`supabase/migrations/20260804040000_payroll_post_advisory_lock.sql:53` takes

```sql
perform pg_advisory_xact_lock(hashtext('payroll_post:' || v_lock_shop::text));
```

a bare hash in Postgres' single global 64-bit advisory keyspace. Nothing else in
the codebase takes an advisory lock today, so nothing collides — but a future
feature using the two-argument `(classid, objid)` form, or small literal keys,
could.

**This is the only item here with a reason to do it now rather than later.**
Changing the key scheme after deployment means old and new function bodies
compute *different* keys. During the window where any session still has the old
body cached, two concurrent posts would not block each other — a double-pay
window opened by the very change meant to prevent one. The migration is not yet
applied to production, so amending it now has no such window at all. Deferring
this converts a free edit into a change requiring a quiet period.

**Design:** use the two-argument form with a reserved classid.

```sql
perform pg_advisory_xact_lock(74920, hashtext(v_lock_shop::text));
```

`74920` is arbitrary but deliberately not a small round number, since 1, 2 and
100 are what a naive future caller reaches for. The migration header carries a
one-line registry noting the classid is reserved for payroll posting and that
future advisory locks must pick a distinct one.

Amending the existing migration rather than adding a new one is correct here for
one specific reason: **it has not been applied to any database except the local
one.** The file is committed and pushed to the `db-fixes` branch, so it is not
"unshared" in the git sense — but no deployed function body was ever built from
it, which is what the deploy-window risk depends on. Anyone else who has run
`supabase db reset` from this branch simply reruns it.

That reasoning is recorded in the plan so it is not mistaken for a general
licence to edit migrations. Once `20260804040000` is applied to production, this
same change would require a new migration and a quiet period.

## B — Refresh the roster after an import that created nobody "accepted"

`src/components/csv-import-modal.tsx:126`:

```tsx
if (result.accepted.length > 0) onImported();
```

Before the pay round-trip work, a successful provision always landed in
`accepted`. Now a member whose provisioning succeeds but whose pay write fails
is reported in `rejected` — correctly, since they exist and need manual
attention — so an import where every pay write fails refreshes nothing, and the
new members do not appear until something else reloads the list.

A pay-write failure is usually systemic (a permission or network problem), so
the all-fail case is the likely shape rather than a rare one.

**Design:** call `onImported()` whenever an import completed, regardless of the
split between accepted and rejected. A wasted refetch after a fully-rejected
import is harmless, and it is correct in every case. This modal is shared with
the customers and products importers; refreshing after a no-op import is
equally harmless there.

## C — Make a silently-filtered update fail loudly

`src/lib/staff.ts` has three functions of identical shape:

```ts
const { error } = await supabase.from('shop_members').update({...}).eq('id', memberId);
if (error) throw error;
```

`updateStaffPay`, `updateStaffRole` and `setStaffActive`. None asks for a row
count, and PostgREST returns 204 with no error when a policy filters the update
to zero rows. The write appears to succeed and nothing changed.

The `write shop_members roster` policy admits `staff.manage` **or**
`people.payroll.manage`, and the client gates match, so divergence needs
something like a stale in-session permission cache after a role change. Narrow —
but the failure is invisible, which is what makes it worth closing.

**Design:** request an exact count and throw when no row was updated.

```ts
const { error, count } = await supabase
  .from('shop_members')
  .update({...}, { count: 'exact' })
  .eq('id', memberId);
if (error) throw error;
if (count === 0) throw new Error('...');
```

**All three functions, not just the reported one.** They share a file, a shape,
a table and a permission gate; fixing one of three reads as an oversight to the
next person. The cost is honest and worth stating: after this change a zero-row
update surfaces an error in the People edit form where it currently fails
quietly. That is better behaviour, but it is behaviour change beyond the
reported finding, and it is the reason this decision was put to the owner
rather than assumed.

Each message names what failed and points at the likely cause — a permission
that no longer allows the write — rather than saying "update failed".

## D — Let the covered count be rechecked without closing the card

The pay-run create card loads the active roster when it opens
(`payroll-tab.tsx:140-157`) and derives the covered count from that snapshot.
`startRun` re-fetches, so a built draft is never stale — but the count and the
Build-draft gate are.

This is reachable. The app uses `NativeTabs` (`src/components/admin-tabs.tsx`),
which keeps screens mounted, so the sequence — open the card, read "No active
staff are on the weekly cadence", go to People, set someone to weekly, come
back — leaves the card showing zero with Build draft still disabled. Recovery is
Cancel then New, which nothing tells the user about.

**Design:** when the count is zero, the message carries a **"Check again"**
control that re-runs the same roster load the card opened with.

Deliberately not a `useEffect` on focus: `payroll-tab.tsx` already carries a
`react-hooks/set-state-in-effect` finding and the lint gate permits no
additional one. An explicit control also matches the moment it serves — the user
has just changed something and wants to see it reflected — where a background
refetch would be invisible.

The existing request-token guard in `openCreate` already prevents a superseded
response from clobbering a fresher one, so repeated taps are safe and need no
further protection.

## E — Say the right thing when there are no staff at all

`payroll-tab.tsx:213-217` tests `cadence === null` before `coveredCount === 0`,
so a shop with no active staff on **Custom dates** renders

> This run covers all 0 active staff.

in the red `coverageEmpty` style. The button is correctly disabled; only the
prose is wrong.

**Design:** test the zero case first, and distinguish the two zeroes — having no
active staff at all is a different problem from having nobody on the chosen
cadence, and the second sentence's advice ("set one in People, or pick a
different period") is useless for the first.

## Testing

This spec has **almost no automated coverage available**, and that is worth
stating rather than implying otherwise:

- **A** — the database harness (`verify-accounting-writes.sql`) must stay green,
  proving the lock still breaks no single-session path. Because the key changed,
  the two-session manual check must be **re-run**, not assumed from the previous
  run: same shop blocks, different shops do not.
- **B, D, E** — no React Native testing library exists in `devDependencies`, so
  these are verified by typecheck, lint and reading.
- **C** — `staff.ts` imports the Supabase client, so it is outside the Jest
  suite by the same rule that keeps the pure modules testable. Verified by
  reading plus the existing People edit flow.

The absence of coverage is the reason each change here is deliberately small and
local. Nothing in this spec introduces logic complex enough to need a test it
cannot have; if a fix started to, that would be the signal to extract a pure
helper instead — the shape used for `staff-pay-columns.ts`.

## Out of scope

- **`hashtext`'s 32-bit width.** Shop keys can collide (~1.2% chance of some
  pair at 10k shops). A collision only makes two unrelated shops serialise
  against each other — extra waiting, never a missed serialisation. Correctness-
  neutral.
- **`unpost_payroll_run` taking the lock.** Reviewed independently: unpost never
  requests the advisory lock, so no deadlock cycle exists, and every interleaving
  either has the poster read a still-committed `posted` status (conservative
  reject) or the unpost commit first (legitimate post). No double-pay path.
- **Shop-wide post serialisation queueing.** Posting is a user-initiated single
  action; serialising is the point.
- **Showing cadence on the People roster.** Still a reasonable later addition.
- **Store hours and team scheduling** — the two large unbuilt features.
