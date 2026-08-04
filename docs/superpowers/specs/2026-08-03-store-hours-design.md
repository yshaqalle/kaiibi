# Store hours — design

**Date:** 2026-08-03
**Status:** Approved, ready for planning
**Scope:** Weekly opening hours. First of the two features remaining from the
original request; team scheduling follows.

## Problem

The app has no concept of when a shop is open. `Shop` carries a name, city,
neighborhood, phone and return policy, but nothing about hours — so a receipt
can't print them, and team scheduling has nothing to validate a shift against.

## What this builds

Seven weekday entries, each a list of open/close ranges:

```
Mon  09:00 – 18:00
Tue  09:00 – 18:00
…
Sun  Closed
```

Editable in Settings → Store, printed on receipts, and readable by a pure
function scheduling will call.

## Decisions

### Each day stores a LIST of ranges, though the editor offers one

```json
{
  "mon": [{ "open": "09:00", "close": "18:00" }],
  "sun": []
}
```

The v1 editor offers exactly one range per day, or Closed. The stored shape is
nonetheless a list.

**This is the one piece of future-proofing this spec pays for, deliberately.**
Adding a lunch or prayer closure later becomes a UI change alone — no
migration, no data rework, no consumer rewrite. Storing `{open, close}` and
adding split shifts later means changing the column, every reader, and every
stored row.

Midday closing is ordinary in the region this app serves — the Somaliland
Shilling support, Zaad and Edahab payment methods, and neighborhood-based
addressing all place it in the Horn of Africa, where closing over lunch and
prayer is common rather than exotic. The list shape also gives "Closed" for free
as an empty array, so it does double duty.

### Times are local wall-clock strings, not timestamps

`"09:00"`, 24-hour, zero-padded. Not a `time` column, not UTC.

Opening hours are a property of the shop's wall clock: a shop that opens at 9am
opens at 9am regardless of daylight saving or the viewer's device timezone.
Storing an instant would make "9am" drift. This also matches how `period.ts`
already reasons about dates — the device's local day — and sidesteps the whole
class of timezone bug this project has hit twice.

A range where `close` is less than or equal to `open` is rejected at entry.
Overnight opening (22:00–02:00) is out of scope; see below.

### One JSONB column on `shops`, no new table

```sql
alter table public.shops
  add column opening_hours jsonb not null default '{}'::jsonb;
```

Seven small fixed-key entries that are always read and written together, never
queried across shops, and never joined. A table of 7 rows per shop would buy
nothing and cost a join on every receipt.

`'{}'` means "not set" and renders as nothing, so every existing shop is
unaffected until an owner fills it in.

**Validation lives in the client, not a CHECK constraint.** A JSONB shape
constraint would be long, hard to read, and would have to be rewritten when
split shifts arrive — for data only this app writes, through one editor. The
pure module is the real guard, and it is unit-tested.

### Deliberately not built

- **Holiday and one-off overrides.** A second table plus rules for which wins on
  a given date. Purely additive later — a date-specific lookup consulted before
  the weekly default — so deferring costs nothing.
- **Per-location hours.** Would move the column off `shops`, but multi-location
  touches inventory, sales and reporting far more than hours (see
  `docs/backlog/2026-08-01-location-directory.md`). Pre-paying here buys little.
- **POS enforcement.** Warning or blocking a sale outside hours needs its own
  thinking about who can override, and nobody has asked for it.
- **Overnight ranges** crossing midnight. `isOpenAt` would need to consider the
  previous day's range too. Rejected at entry rather than silently mis-stored.

## Architecture

### New module: `src/lib/store-hours.ts`

Pure — no Supabase import — so it loads under Jest like `pay-rate.ts`,
`pay-periods.ts` and `staff-pay-columns.ts`.

```ts
type TimeRange = { open: string; close: string };   // 'HH:MM', 24-hour
type WeekdayKey = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';
type OpeningHours = Partial<Record<WeekdayKey, TimeRange[]>>;

weekdayKeyFor(date: Date): WeekdayKey
isOpenAt(hours: OpeningHours, at: Date): boolean
rangesFor(hours: OpeningHours, day: WeekdayKey): TimeRange[]
isValidTime(text: string): boolean            // 'HH:MM', 00:00-23:59
isValidRange(range: TimeRange): boolean       // valid times AND close > open
formatDayHours(ranges: TimeRange[]): string   // '09:00 – 18:00' | 'Closed'
formatWeek(hours: OpeningHours): { day: string; hours: string }[]
```

`isOpenAt` is the function team scheduling will call to validate that a shift
falls inside opening hours. Building it now, with tests, is most of why this
spec exists — the display is the smaller half.

**Boundary rule, stated so it is not ambiguous:** a range is inclusive of `open`
and exclusive of `close`. A shop open 09:00–18:00 is open at exactly 09:00 and
closed at exactly 18:00. This matters for a shift ending at closing time, which
scheduling must treat as valid.

`weekdayKeyFor` uses the device's local day, consistent with `period.ts`.

**Display is 24-hour, matching storage** — `09:00 – 18:00`, not `9:00 AM`.
Deliberately not `toLocaleTimeString`: a locale-dependent format would make the
formatter's tests depend on the machine's locale, which is exactly the class of
environment-sensitive test this project already had to fix once by pinning `TZ`
in `jest.config.js`. 24-hour is also the common written form in the region, and
it keeps what is displayed identical to what is stored, so a support question
about a shop's hours has one answer rather than two.

### Data layer

`Shop` gains `openingHours: OpeningHours`. `mapShopRow` reads
`row.opening_hours ?? {}`; `updateShop` writes it under the existing
`!== undefined` pattern.

### Settings → Store

A new "Opening hours" section, seven rows. Each row is a day name, a Closed
toggle, and two time inputs when not closed. The existing `Section` / `Row`
primitives carry it; time entry uses plain text inputs validated by
`isValidTime`, matching how `DateInput` handles dates rather than introducing a
picker.

Invalid input blocks Save with a message naming the day, rather than saving a
range the rest of the app cannot interpret.

### Receipt

`ReceiptData` gains `shopHours: string | null` — a single pre-formatted line for
*today*, e.g. `Open today 09:00 – 18:00`, or omitted when hours are unset.

A whole week's table would dominate a narrow receipt; today's line is what a
customer holding the receipt actually wants. Formatting happens where
`ReceiptData` is built, so the renderers stay presentational.

## Testing

`src/lib/__tests__/store-hours.test.ts` covers the pure module — real coverage,
unlike the previous spec:

- `isOpenAt` inside, before and after a range.
- The boundary rule explicitly: open at exactly `open`, closed at exactly
  `close`.
- A day with an empty array is always closed.
- A day absent from the object is always closed.
- Two ranges in one day (the split-shift shape the editor does not yet produce,
  proving the stored shape works before the UI catches up), including the gap
  between them reading as closed.
- `weekdayKeyFor` for all seven days, including that Sunday maps to `sun` —
  `Date.getDay()` returns 0 for Sunday, which is the off-by-one worth pinning.
- `isValidTime` rejects `'25:00'`, `'9:00'` (unpadded), `'0900'`, `''`.
- `isValidRange` rejects `close === open` and `close < open`.
- `formatDayHours` for one range, two ranges, and empty.

The Settings editor and the receipt line have no automated coverage — no React
Native testing library exists in `devDependencies` — so they are verified by
typecheck, lint and reading. That is the reason the logic lives in the pure
module rather than in the component.

## Sequence

1. **This spec — store hours.**
2. **Team scheduling**, which consumes `isOpenAt`.

Everything earlier in the payroll sequence is complete and pushed; migration
`20260804040000` is the only one not yet applied to production.
