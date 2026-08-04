# Team scheduling — design

**Date:** 2026-08-03
**Status:** Approved, ready for planning
**Scope:** Weekly shift scheduling. Last of the three features from the original
request; store hours and salary pay-frequency are complete.

## Problem

The app records what already happened — `time_entries` for clocked hours,
`time_off_requests` for approved leave — but has no way to say what is *going
to* happen. A shop owner cannot tell staff when to come in, and staff cannot
look up their own next shift.

## What this builds

A shift is one member, one date, a start and an end. A week view shows who is on
when, an editor creates and changes them, validation catches the obvious
mistakes, and each member sees their own shifts on the `/me` screen.

## Deliberately not built

Each of these would roughly double the work. They are listed with the reason so
a later reader can tell they were decided rather than forgotten.

- **Recurring shifts.** A pattern model brings exceptions, "edit this occurrence
  or the whole series", and end dates. Replaced by **copy last week** (below),
  which captures most of the value — rotas do repeat, but with weekly tweaks
  anyway — with none of the series semantics. A real pattern model can be added
  later without changing the shift table.
- **Draft versus published rotas.** Staff see shifts as soon as they exist.
- **Shift swaps.** An approval workflow, essentially a second copy of time-off.
- **Coverage warnings** ("nobody on Tuesday morning"). Needs a notion of required
  staffing per period, which does not exist.
- **Planned versus actual** — comparing shifts to `time_entries`. A natural
  pairing with the payroll work and a good follow-up, but a reporting feature in
  its own right.
- **Labour cost forecast** — scheduled hours × pay rates. Every piece now exists
  after the payroll work, which is exactly why it is tempting and why it should
  be its own decision.
- **Notifications.** Impossible regardless:
  `docs/backlog/2026-08-01-notification-delivery.md` is unbuilt, so nothing in
  the app can tell anyone anything. Staff check the app.

## Decisions

### One table, times as `'HH:MM'` text

```sql
create table public.shifts (
  id             uuid primary key default gen_random_uuid(),
  shop_id        uuid not null references public.shops(id) on delete cascade,
  shop_member_id uuid not null references public.shop_members(id) on delete cascade,
  shift_date     date not null,
  start_time     text not null check (start_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  end_time       text not null check (end_time   ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  note           text,
  created_by     uuid references auth.users(id),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint shifts_time_ordered check (end_time > start_time)
);
```

Times match the convention `opening_hours` already uses: local wall-clock
strings, not instants. A shift at 09:00 is at 09:00 regardless of daylight
saving or the viewer's device, and `isRangeWithinHours` takes a shift directly
with no conversion. Zero-padding makes the lexicographic `end_time > start_time`
comparison correct, and one representation runs from database to UI.

**Format CHECKs are included here, having been declined for `opening_hours`.**
That is not inconsistency: this is a one-line regex on a scalar column, not a
recursive JSONB shape constraint that would need rewriting the moment the shape
gains split shifts.

Overnight shifts crossing midnight are rejected by `shifts_time_ordered`, the
same limitation opening hours has, for the same reason — the alternative is
interpreting an end before a start, which is more often a typo than an
intention.

### A new permission, `people.schedule.manage`

Matching the granularity already there (`people.timesheet.view`,
`people.timeoff.approve`, `people.payroll.manage`). Added to `PERMISSIONS` in
`src/lib/permissions.ts` and to the manager preset in `permission-groups.ts`.

RLS on `shifts`:

- **Read** — your own shifts always; everyone's with `people.schedule.manage`.
- **Write** — `people.schedule.manage` only.

Reading your own row without a permission is the same shape as the existing
"staff reads own membership" policy, and it is what makes the `/me` view work
for an ordinary cashier.

### Validation: one blocker, two warnings

A pure `src/lib/scheduling.ts` exposes:

```ts
type ShiftProblem = { kind: 'overlap' | 'outside_hours' | 'on_leave'; blocking: boolean; message: string }
validateShift(shift: ShiftDraft, context: { hours: OpeningHours; onLeave: Set<string>; sameDayShifts: Shift[] }): ShiftProblem[]
```

| Check | Behaviour | Why |
|---|---|---|
| Overlaps another shift for the same member that day | **Blocks** | Incoherent — one person cannot be in two places |
| Falls outside store opening hours | Warns | A stock-take before opening is a real shift |
| Member has approved leave that day | Warns | Leave gets rearranged; the manager may know something the app does not |

This mirrors the payroll draft-warnings design, where only the case that is
*wrong* blocks and the merely *unusual* ones inform.

**Overlap uses the same boundary convention as opening hours:** a shift starting
exactly when another ends does **not** overlap. Two adjacent shifts, 09:00–13:00
and 13:00–17:00, are valid.

**The opening-hours check is skipped entirely when `isConfigured(hours)` is
false.** This is precisely why that predicate was added: `opening_hours`
defaults to `{}` with no backfill, so without the guard every shop that has
never opened Settings would see a warning on every shift it ever created. The
store-hours final review caught that gap; this is the payoff.

Leave reuses `onLeaveMemberIds` from `shift-hours.ts` rather than
reimplementing date-range logic that already handles non-contiguous ranges.

### Copy last week, not recurrence

One action in the week header duplicates the previous week's shifts into the
displayed week, shifting each date forward by seven days.

It **skips** any shift that would collide with one already present for that
member and day, and reports both counts — "copied 11 shifts, skipped 2 that
clashed" — rather than silently doing partial work or refusing the whole
operation because of one clash.

## Architecture

### `src/lib/scheduling.ts` — pure

No Supabase import, so it loads under Jest like `store-hours.ts`,
`pay-periods.ts` and `staff-pay-columns.ts`.

```ts
type ShiftDraft = { shopMemberId: string; date: string; start: string; end: string }
type Shift = ShiftDraft & { id: string; shopId: string; note: string | null }
type ValidationContext = { hours: OpeningHours; onLeave: Set<string>; sameDayShifts: Shift[] }

validateShift(draft: ShiftDraft, context: ValidationContext): ShiftProblem[]
hasBlockingProblem(problems: ShiftProblem[]): boolean
shiftMinutes(draft: ShiftDraft): number
weekDaysFrom(monday: string): string[]          // seven 'YYYY-MM-DD', Monday first
startOfWeek(date: string): string               // the Monday of that date's week
shiftsToCopy(previous: Shift[], existing: Shift[]): { copy: ShiftDraft[]; skipped: number }
```

Dates crossing this boundary are `'YYYY-MM-DD'` strings, and day stepping uses
calendar-component arithmetic — never millisecond addition, which lands at 23:00
the previous day across a DST boundary. That bug reached production once in this
project already.

### Data layer — `src/lib/shifts.ts`

`listShiftsForWeek(shopId, mondayDate)`, `listMyShifts(shopMemberId, fromDate)`,
`createShift`, `updateShift`, `deleteShift`, `copyPreviousWeek`. Row mapping in
the file's established shape.

### UI

**A fourth tab on the People screen** — `customers | team | schedule | me` —
using the existing `SegmentedControl`. Scheduling is a people activity and that
screen already carries the tab machinery, permission gating and compact/wide
handling.

**The Schedule tab is gated on `people.schedule.manage`** and hidden without it,
matching how the Customers and Team tabs are already gated. A cashier does not
see a tab whose rows RLS would blank anyway — they see their own shifts on `/me`,
which needs no permission. `people.tsx` builds its tab options from `can(...)`
checks, so this is one more entry in that list rather than new machinery.

- **Wide (tablet):** a grid, seven day columns by one row per active member.
- **Compact (phone):** a day strip to choose a day, then that day's shifts as a
  list. A seven-column grid is unusable at phone width, and `people.tsx` already
  branches on `TABLET_BREAKPOINT` exactly this way.

A shift editor modal takes member, date, start, end and note. Warnings render
inline; a blocking problem disables Save. `/me` gains a "My shifts" section
listing the signed-in member's upcoming shifts.

## Testing

`src/lib/__tests__/scheduling.test.ts` — real coverage, since the logic lives
here rather than in the editor:

- Each validation problem in isolation, and two at once.
- The `isConfigured` skip: an unconfigured shop produces no hours warning.
- Overlap at the boundary: 09:00–13:00 and 13:00–17:00 do **not** overlap;
  09:00–13:00 and 12:00–17:00 do.
- Overlap ignores a different member, and a different day.
- `weekDaysFrom` and `startOfWeek` across a month boundary, a year boundary and
  a leap year, including that Sunday belongs to the week that started on the
  preceding Monday.
- `shiftsToCopy` skips a collision and counts it.

Database tests alongside the existing accounting harness: a member can read
their own shift without `people.schedule.manage`, cannot read a colleague's, and
cannot write at all. That is the part no unit test reaches and the part that
protects staff privacy.

The UI has no automated coverage — no React Native testing library exists in
`devDependencies` — which is the reason validation lives in the pure module.

## Sequence

1. **Salary pay-frequency** — complete, migrations applied.
2. **Store hours** — complete, migration applied.
3. **This spec — team scheduling.**

Natural follow-ups once this lands: planned-versus-actual against
`time_entries`, and a labour-cost forecast from scheduled hours and pay rates.
Both are now cheap to build and both deserve their own decision.
