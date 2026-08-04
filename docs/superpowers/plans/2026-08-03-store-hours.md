# Store Hours Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give a shop weekly opening hours — editable in Settings, printed on receipts, and readable by the pure function team scheduling will call to validate a shift.

**Architecture:** One JSONB column on `shops` holding seven weekday keys, each an array of `{open, close}` local wall-clock strings. A pure `src/lib/store-hours.ts` owns every rule about that shape — validity, "is the shop open at time T", and formatting. The Settings editor and the receipt line are thin consumers.

**Tech Stack:** Expo SDK 57, React Native 0.86, React 19.2, TypeScript 6.0, Jest 29 (`jest-expo`, TZ pinned to `America/New_York`), Supabase/Postgres 17.

**Spec:** `docs/superpowers/specs/2026-08-03-store-hours-design.md`

## Global Constraints

- **Expo SDK 57.** Per `AGENTS.md`, consult https://docs.expo.dev/versions/v57.0.0/ before writing framework code. Tasks 3 and 4 use only primitives already imported in the files they touch.
- **Times are local wall-clock strings, `"HH:MM"`, 24-hour, zero-padded.** Never a timestamp, never UTC, never `toISOString`. A shop that opens at 9am opens at 9am regardless of DST or the viewer's device.
- **Display format is 24-hour and fixed** — `09:00 – 18:00`. Deliberately NOT `toLocaleTimeString`: a locale-dependent format makes the formatter's tests depend on the machine's locale, the same class of environment-sensitive test that already forced pinning `TZ` in `jest.config.js`.
- **A range is inclusive of `open`, exclusive of `close`.** A shop open 09:00–18:00 is open at exactly 09:00 and closed at exactly 18:00. Scheduling depends on this: a shift ending at closing time must be valid.
- **Each day stores a LIST of ranges** even though the v1 editor offers one. This is the spec's one deliberate piece of future-proofing — do not "simplify" it to a single `{open, close}`.
- **`src/lib/store-hours.ts` imports no Supabase**, so it loads under Jest. `@/lib/period` is dependency-free and safe; `@/lib/shops` and `@/lib/staff` are NOT.
- **`npx jest`** baseline **14 suites / 285 tests**. `jest.config.js` pins `process.env.TZ = 'America/New_York'` — do not remove it.
- **`npx tsc --noEmit`** clean; **`npx expo lint`** has **42 known pre-existing problems (38 errors, 4 warnings)** and must gain none. Several are `react-hooks/set-state-in-effect` — avoid adding an effect that sets state.
- **Database work is local only.** Stack is running; `DB_URL` is `postgresql://postgres:postgres@127.0.0.1:54322/postgres`. **Never run `supabase db push`** — the remote is production.
- **Migration versions must sort after `20260804040000`**, the current latest.

---

### Task 1: `store-hours.ts` — the rules about opening hours

Every rule about the shape lives here, with real tests. Tasks 2-4 are thin consumers.

**Files:**
- Create: `src/lib/store-hours.ts`
- Create: `src/lib/__tests__/store-hours.test.ts`

**Interfaces:**
- Consumes: nothing. No imports outside its own types.
- Produces, relied on by Tasks 2–4:
  ```ts
  type TimeRange = { open: string; close: string }
  type WeekdayKey = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun'
  type OpeningHours = Partial<Record<WeekdayKey, TimeRange[]>>
  WEEK_ORDER: readonly WeekdayKey[]                    // mon..sun, for UI iteration
  DAY_LABELS: Record<WeekdayKey, string>               // 'Monday', ...
  weekdayKeyFor(date: Date): WeekdayKey
  isValidTime(text: string): boolean
  isValidRange(range: TimeRange): boolean
  rangesFor(hours: OpeningHours, day: WeekdayKey): TimeRange[]
  isOpenAt(hours: OpeningHours, at: Date): boolean
  formatDayHours(ranges: TimeRange[]): string
  ```

  The spec's module sketch also listed `formatWeek`, for rendering a whole
  week's table. It is deliberately not built: no task consumes it, the Settings
  editor renders its own rows, and the receipt shows only today. Shipping a
  tested function nothing calls is still dead code. Add it when a caller exists.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/__tests__/store-hours.test.ts`:

```ts
import {
  formatDayHours,
  isOpenAt,
  isValidRange,
  isValidTime,
  rangesFor,
  weekdayKeyFor,
  type OpeningHours,
} from '@/lib/store-hours';

// 2026-08-03 is a Monday. Every date below is chosen from that week so the
// weekday is obvious from the day-of-month.
const MONDAY = '2026-08-03';

function at(day: string, time: string): Date {
  const [y, m, d] = day.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  return new Date(y, m - 1, d, hh, mm);
}

const NINE_TO_SIX: OpeningHours = { mon: [{ open: '09:00', close: '18:00' }] };

describe('weekdayKeyFor', () => {
  // Date.getDay() returns 0 for SUNDAY, not Monday. Getting this wrong shifts
  // every day by one and is invisible until someone checks a real date.
  it('maps each day of the week correctly', () => {
    expect(weekdayKeyFor(at('2026-08-03', '12:00'))).toBe('mon');
    expect(weekdayKeyFor(at('2026-08-04', '12:00'))).toBe('tue');
    expect(weekdayKeyFor(at('2026-08-05', '12:00'))).toBe('wed');
    expect(weekdayKeyFor(at('2026-08-06', '12:00'))).toBe('thu');
    expect(weekdayKeyFor(at('2026-08-07', '12:00'))).toBe('fri');
    expect(weekdayKeyFor(at('2026-08-08', '12:00'))).toBe('sat');
    expect(weekdayKeyFor(at('2026-08-09', '12:00'))).toBe('sun');
  });
});

describe('isValidTime', () => {
  it('accepts a zero-padded 24-hour time', () => {
    expect(isValidTime('00:00')).toBe(true);
    expect(isValidTime('09:00')).toBe(true);
    expect(isValidTime('23:59')).toBe(true);
  });

  it('rejects an out-of-range hour or minute', () => {
    expect(isValidTime('24:00')).toBe(false);
    expect(isValidTime('25:00')).toBe(false);
    expect(isValidTime('12:60')).toBe(false);
  });

  it('rejects anything not exactly HH:MM', () => {
    expect(isValidTime('9:00')).toBe(false);
    expect(isValidTime('0900')).toBe(false);
    expect(isValidTime('')).toBe(false);
    expect(isValidTime('09:00:00')).toBe(false);
    expect(isValidTime('nine')).toBe(false);
  });
});

describe('isValidRange', () => {
  it('accepts a range that closes after it opens', () => {
    expect(isValidRange({ open: '09:00', close: '18:00' })).toBe(true);
  });

  // Overnight opening is out of scope, so an end at or before the start is a
  // typo rather than a shape to interpret.
  it('rejects a zero-length or backwards range', () => {
    expect(isValidRange({ open: '09:00', close: '09:00' })).toBe(false);
    expect(isValidRange({ open: '18:00', close: '09:00' })).toBe(false);
  });

  it('rejects a range containing an invalid time', () => {
    expect(isValidRange({ open: '9:00', close: '18:00' })).toBe(false);
    expect(isValidRange({ open: '09:00', close: '25:00' })).toBe(false);
  });
});

describe('isOpenAt', () => {
  it('is open inside the range', () => {
    expect(isOpenAt(NINE_TO_SIX, at(MONDAY, '12:00'))).toBe(true);
  });

  it('is closed before and after the range', () => {
    expect(isOpenAt(NINE_TO_SIX, at(MONDAY, '08:59'))).toBe(false);
    expect(isOpenAt(NINE_TO_SIX, at(MONDAY, '18:01'))).toBe(false);
  });

  // The boundary rule scheduling depends on: a shift ending at closing time
  // must be valid, so `close` is exclusive and `open` is inclusive.
  it('is open at exactly the opening time and closed at exactly the closing time', () => {
    expect(isOpenAt(NINE_TO_SIX, at(MONDAY, '09:00'))).toBe(true);
    expect(isOpenAt(NINE_TO_SIX, at(MONDAY, '18:00'))).toBe(false);
  });

  it('is closed on a day with an empty range list', () => {
    expect(isOpenAt({ mon: [] }, at(MONDAY, '12:00'))).toBe(false);
  });

  it('is closed on a day absent from the object', () => {
    expect(isOpenAt({}, at(MONDAY, '12:00'))).toBe(false);
    expect(isOpenAt(NINE_TO_SIX, at('2026-08-04', '12:00'))).toBe(false);
  });

  // The stored shape allows two ranges per day before the editor offers them.
  // This proves the shape works ahead of the UI.
  it('handles a split day, and is closed in the gap', () => {
    const split: OpeningHours = { mon: [{ open: '09:00', close: '13:00' }, { open: '15:00', close: '18:00' }] };
    expect(isOpenAt(split, at(MONDAY, '10:00'))).toBe(true);
    expect(isOpenAt(split, at(MONDAY, '14:00'))).toBe(false);
    expect(isOpenAt(split, at(MONDAY, '16:00'))).toBe(true);
  });

  // A malformed range must not accidentally open the shop.
  it('ignores an invalid range rather than treating it as open', () => {
    expect(isOpenAt({ mon: [{ open: '18:00', close: '09:00' }] }, at(MONDAY, '12:00'))).toBe(false);
  });
});

describe('rangesFor', () => {
  it('returns an empty array for a day that is absent', () => {
    expect(rangesFor({}, 'mon')).toEqual([]);
  });

  it('returns the day’s ranges', () => {
    expect(rangesFor(NINE_TO_SIX, 'mon')).toEqual([{ open: '09:00', close: '18:00' }]);
  });
});

describe('formatDayHours', () => {
  it('formats one range in 24-hour time', () => {
    expect(formatDayHours([{ open: '09:00', close: '18:00' }])).toBe('09:00 – 18:00');
  });

  it('joins two ranges', () => {
    expect(formatDayHours([{ open: '09:00', close: '13:00' }, { open: '15:00', close: '18:00' }])).toBe(
      '09:00 – 13:00, 15:00 – 18:00'
    );
  });

  it('says Closed for no ranges', () => {
    expect(formatDayHours([])).toBe('Closed');
  });

  it('says Closed when every range is invalid', () => {
    expect(formatDayHours([{ open: '18:00', close: '09:00' }])).toBe('Closed');
  });
});

```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest src/lib/__tests__/store-hours.test.ts`
Expected: FAIL — `Cannot find module '@/lib/store-hours'`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/store-hours.ts`:

```ts
// When a shop is open, and every rule about that shape.
//
// Pure: no Supabase import, so it loads under Jest like pay-rate.ts and
// pay-periods.ts. The Settings editor and the receipt line are thin consumers,
// which is deliberate -- there is no React Native testing library in this repo,
// so logic in a component is logic no test can reach.

// Local wall-clock 'HH:MM', 24-hour, zero-padded. NOT a timestamp: a shop that
// opens at 9am opens at 9am regardless of daylight saving or the viewer's
// device timezone, and storing an instant would make that drift.
export type TimeRange = { open: string; close: string };

export type WeekdayKey = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';

// A LIST per day, though the editor offers one range. Adding a lunch or prayer
// closure later is then a UI change alone -- no migration, no data rework. An
// empty list means closed; an absent key means the same.
export type OpeningHours = Partial<Record<WeekdayKey, TimeRange[]>>;

// Indexed by Date.getDay(), which returns 0 for SUNDAY. Keeping that mapping
// in one place is why this array exists rather than arithmetic at each site.
const KEYS_BY_GET_DAY: readonly WeekdayKey[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

// Display order, which starts on Monday rather than Sunday.
export const WEEK_ORDER: readonly WeekdayKey[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

export const DAY_LABELS: Record<WeekdayKey, string> = {
  mon: 'Monday',
  tue: 'Tuesday',
  wed: 'Wednesday',
  thu: 'Thursday',
  fri: 'Friday',
  sat: 'Saturday',
  sun: 'Sunday',
};

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function weekdayKeyFor(date: Date): WeekdayKey {
  return KEYS_BY_GET_DAY[date.getDay()];
}

export function isValidTime(text: string): boolean {
  return TIME_PATTERN.test(text);
}

function minutesOf(time: string): number {
  const [hours, minutes] = time.split(':').map(Number);
  return hours * 60 + minutes;
}

// Overnight opening (22:00-02:00) is out of scope, so a close at or before the
// open is a typo rather than a shape to interpret.
export function isValidRange(range: TimeRange): boolean {
  if (!isValidTime(range.open) || !isValidTime(range.close)) return false;
  return minutesOf(range.close) > minutesOf(range.open);
}

export function rangesFor(hours: OpeningHours, day: WeekdayKey): TimeRange[] {
  return hours[day] ?? [];
}

// The function team scheduling calls to check a shift falls inside opening
// hours. Inclusive of `open`, EXCLUSIVE of `close`: a shift ending at closing
// time is valid, which is the whole reason the boundary is pinned down.
//
// Invalid ranges are skipped rather than trusted -- a malformed row must not
// accidentally report the shop open.
export function isOpenAt(hours: OpeningHours, at: Date): boolean {
  const minutes = at.getHours() * 60 + at.getMinutes();
  return rangesFor(hours, weekdayKeyFor(at)).some(
    (range) => isValidRange(range) && minutes >= minutesOf(range.open) && minutes < minutesOf(range.close)
  );
}

// 24-hour, matching storage. Deliberately not toLocaleTimeString: a
// locale-dependent format would make these tests depend on the machine's
// locale, and it keeps what is shown identical to what is stored.
export function formatDayHours(ranges: TimeRange[]): string {
  const valid = ranges.filter(isValidRange);
  if (valid.length === 0) return 'Closed';
  return valid.map((range) => `${range.open} – ${range.close}`).join(', ');
}

```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest src/lib/__tests__/store-hours.test.ts`
Expected: PASS, 20 tests.

- [ ] **Step 5: Full suite and typecheck**

Run: `npx jest && npx tsc --noEmit`
Expected: `Test Suites: 15 passed, 15 total`, `Tests: 305 passed` (285 + 20). No TypeScript output.

- [ ] **Step 6: Commit**

```bash
git add src/lib/store-hours.ts src/lib/__tests__/store-hours.test.ts
git commit -m "feat: add store-hours module

Every rule about opening hours lives here with real tests, because the
editor and the receipt line can't have any -- there is no React Native
testing library in this repo, so logic in a component is logic no test
can reach.

isOpenAt is what team scheduling will call to validate a shift. Its
boundary is pinned deliberately: inclusive of open, exclusive of close,
so a shift ending at closing time is valid.

Each day stores a list of ranges though the editor will offer one, so
adding a lunch or prayer closure later is a UI change alone."
```

---

### Task 2: The column and the data layer

**Files:**
- Create: `supabase/migrations/20260805000000_store_opening_hours.sql`
- Modify: `src/types/models.ts` (`Shop`)
- Modify: `src/lib/shops.ts` (`mapShopRow`, `updateShop` input type and update object)

**Interfaces:**
- Consumes: `OpeningHours` from `@/lib/store-hours` (Task 1).
- Produces, relied on by Tasks 3–4:
  ```ts
  Shop.openingHours: OpeningHours     // never null; {} means not set
  updateShop(id, { openingHours?: OpeningHours, ... })
  ```

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/20260805000000_store_opening_hours.sql`:

```sql
-- When a shop is open. The schema had no concept of it: shops carried a name,
-- city, neighborhood, phone and return policy, so a receipt couldn't print
-- hours and team scheduling had nothing to validate a shift against.
--
-- One JSONB column rather than a table of seven rows per shop: the entries are
-- always read and written together, never queried across shops and never
-- joined, so a table would buy nothing and cost a join on every receipt.
--
-- Shape: { "mon": [{"open":"09:00","close":"18:00"}], "sun": [] }
-- Times are local wall-clock strings, NOT timestamps -- a shop that opens at
-- 9am opens at 9am regardless of daylight saving or the viewer's device.
-- Each day is a LIST so a lunch or prayer closure can be added later as a UI
-- change alone. An empty list means closed; an absent key means the same.
--
-- Deliberately no CHECK constraint on the shape: it would be long, hard to
-- read, and would have to be rewritten when split shifts arrive -- for data
-- only this app writes, through one editor. src/lib/store-hours.ts is the real
-- guard and it is unit-tested.

alter table public.shops
  add column opening_hours jsonb not null default '{}'::jsonb;

comment on column public.shops.opening_hours is
  'Weekly opening hours keyed by weekday (mon..sun), each an array of {open,close} local wall-clock HH:MM strings. Empty array = closed that day. {} = not set. Validated in src/lib/store-hours.ts, not by a constraint.';
```

- [ ] **Step 2: Apply locally and confirm the chain builds from scratch**

Run: `supabase db reset`
Expected: ends `Finished supabase db reset.` with no error.

- [ ] **Step 3: Add the type**

In `src/types/models.ts`, add to the imports at the top:

```ts
import type { OpeningHours } from '@/lib/store-hours';
```

Add to `Shop`, after `payPeriodAnchor`:

```ts
  // Weekly opening hours. `{}` means the owner hasn't set them, which renders
  // as nothing rather than as "closed all week".
  openingHours: OpeningHours;
```

- [ ] **Step 4: Map and write the column**

In `src/lib/shops.ts`, add to `mapShopRow`'s returned object after `payPeriodAnchor`:

```ts
    openingHours: row.opening_hours ?? {},
```

Add `openingHours: OpeningHours;` to `updateShop`'s input type, on the same line as `payPeriodAnchor` (this codebase keeps that type's fields on grouped lines rather than one per line). Add the import for the type at the top of the file.

Add to `updateShop`'s update object, after the `payPeriodAnchor` entry:

```ts
      ...(input.openingHours !== undefined && { opening_hours: input.openingHours }),
```

- [ ] **Step 5: Verify**

Run: `npx jest && npx tsc --noEmit && npx expo lint`
Expected: `Test Suites: 15 passed`, `Tests: 305 passed`; no TypeScript output; lint at 42 problems, no new ones.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20260805000000_store_opening_hours.sql src/types/models.ts src/lib/shops.ts
git commit -m "feat: store opening hours on the shop

One JSONB column rather than seven rows per shop: the entries are always
read and written together, never queried across shops and never joined.

No CHECK on the shape -- it would be long, hard to read, and would need
rewriting when split shifts arrive, for data only this app writes through
one editor. store-hours.ts is the guard, and it's unit-tested."
```

---

### Task 3: The Settings editor

**Files:**
- Create: `src/components/settings/opening-hours-editor.tsx`
- Modify: `src/components/settings/panels/store-panel.tsx`

**Interfaces:**
- Consumes: `OpeningHours`, `TimeRange`, `WeekdayKey`, `WEEK_ORDER`, `DAY_LABELS`, `isValidRange`, `rangesFor` from `@/lib/store-hours` (Task 1); `Shop.openingHours` and `updateShop` from Task 2.
- Produces: nothing consumed by Task 4.

The editor is its own file so `store-panel.tsx` doesn't absorb seven rows of time inputs. No automated coverage is possible — there is no React Native testing library — so this task is verified by typecheck, lint and reading.

- [ ] **Step 1: Create the editor component**

Create `src/components/settings/opening-hours-editor.tsx`:

```tsx
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import {
  DAY_LABELS,
  WEEK_ORDER,
  isValidTime,
  rangesFor,
  type OpeningHours,
  type WeekdayKey,
} from '@/lib/store-hours';

// Seven rows, one per weekday. The stored shape allows several ranges a day,
// but this editor offers one or Closed -- see the spec: the list shape exists
// so a lunch or prayer closure can be added later without touching the column
// or its readers.
//
// Times are plain text inputs validated against 'HH:MM', matching how DateInput
// handles dates in this codebase rather than introducing a picker.

const DEFAULT_RANGE = { open: '09:00', close: '18:00' };

function setDay(hours: OpeningHours, day: WeekdayKey, ranges: { open: string; close: string }[]): OpeningHours {
  return { ...hours, [day]: ranges };
}

function DayRow({
  day,
  hours,
  onChange,
}: {
  day: WeekdayKey;
  hours: OpeningHours;
  onChange: (next: OpeningHours) => void;
}) {
  const ranges = rangesFor(hours, day);
  const range = ranges[0];
  const closed = range === undefined;

  return (
    <View style={styles.row}>
      <Text style={styles.day}>{DAY_LABELS[day]}</Text>
      {closed ? (
        <>
          <Text style={styles.closed}>Closed</Text>
          <Pressable onPress={() => onChange(setDay(hours, day, [DEFAULT_RANGE]))}>
            <Text style={styles.action}>Set hours</Text>
          </Pressable>
        </>
      ) : (
        <>
          <TextInput
            value={range.open}
            onChangeText={(open) => onChange(setDay(hours, day, [{ ...range, open }]))}
            placeholder="09:00"
            placeholderTextColor="#999999"
            style={[styles.time, !isValidTime(range.open) && styles.timeInvalid]}
          />
          <Text style={styles.dash}>–</Text>
          <TextInput
            value={range.close}
            onChangeText={(close) => onChange(setDay(hours, day, [{ ...range, close }]))}
            placeholder="18:00"
            placeholderTextColor="#999999"
            style={[styles.time, !isValidTime(range.close) && styles.timeInvalid]}
          />
          <Pressable onPress={() => onChange(setDay(hours, day, []))}>
            <Text style={styles.action}>Close</Text>
          </Pressable>
        </>
      )}
    </View>
  );
}

export function OpeningHoursEditor({ value, onChange }: { value: OpeningHours; onChange: (next: OpeningHours) => void }) {
  return (
    <View>
      {WEEK_ORDER.map((day) => (
        <DayRow key={day} day={day} hours={value} onChange={onChange} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: '#F2F2F2' },
  day: { fontSize: 13, fontWeight: '700', color: '#111111', width: 92 },
  closed: { fontSize: 13, color: '#999999', flex: 1 },
  time: { backgroundColor: '#F2F2F2', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, fontSize: 13, color: '#111111', width: 72, textAlign: 'center' },
  timeInvalid: { borderWidth: 1, borderColor: '#C0392B', color: '#C0392B' },
  dash: { fontSize: 13, color: '#999999' },
  action: { fontSize: 12, fontWeight: '700', color: '#111111', marginLeft: 'auto' },
});
```

- [ ] **Step 2: Wire it into the Store panel**

In `src/components/settings/panels/store-panel.tsx`, add to the imports:

```tsx
import { OpeningHoursEditor } from '@/components/settings/opening-hours-editor';
import { DAY_LABELS, WEEK_ORDER, isValidRange, rangesFor, type OpeningHours } from '@/lib/store-hours';
```

Add state beside the existing fields:

```tsx
  const [openingHours, setOpeningHours] = useState<OpeningHours>(shop.openingHours);
```

Add to the `dirty` check:

```tsx
    JSON.stringify(openingHours) !== JSON.stringify(shop.openingHours);
```

(append as a new `||` clause; note the existing final clause ends without `||`)

- [ ] **Step 3: Block saving an unparseable range**

In `save`, before `setSaving(true)`, add:

```tsx
    // A range the rest of the app can't interpret must not reach the database.
    // Naming the day matters: seven rows of time inputs make "invalid time"
    // alone useless.
    const badDay = WEEK_ORDER.find((day) => rangesFor(openingHours, day).some((range) => !isValidRange(range)));
    if (badDay) {
      setError(`${DAY_LABELS[badDay]}'s hours aren't valid — use 24-hour times like 09:00, and close after you open.`);
      return;
    }
```

Add `openingHours` to the `updateShop` call, after `payPeriodAnchor`:

```tsx
        openingHours,
```

- [ ] **Step 4: Render the section**

Add after the existing "Payroll" section:

```tsx
      <Section title="Opening hours">
        <OpeningHoursEditor value={openingHours} onChange={setOpeningHours} />
      </Section>
```

- [ ] **Step 5: Verify**

Run: `npx jest && npx tsc --noEmit && npx expo lint`
Expected: `Test Suites: 15 passed`, `Tests: 305 passed` (unchanged — this task adds no tests); no TypeScript output; lint at exactly 42 problems.

If lint reports 43, you added an effect that sets state — the editor is fully controlled and needs none.

- [ ] **Step 6: Commit**

```bash
git add src/components/settings/opening-hours-editor.tsx src/components/settings/panels/store-panel.tsx
git commit -m "feat: edit opening hours in Settings

Its own file so store-panel doesn't absorb seven rows of time inputs.
Fully controlled, so no effect and no new lint finding.

Saving is blocked on a range the rest of the app couldn't interpret, and
the message names the day -- with seven rows of inputs, 'invalid time'
alone would be useless."
```

---

### Task 4: The receipt line

**Files:**
- Modify: `src/lib/receipt.ts` — `ReceiptData` type, `buildReceiptData`, `buildReceiptText`, the HTML renderer
- Modify: `src/components/receipt-modal.tsx`

**Interfaces:**
- Consumes: `formatDayHours`, `rangesFor`, `weekdayKeyFor` from `@/lib/store-hours` (Task 1); `Shop.openingHours` from Task 2.
- Produces: nothing. This is the last task.

- [ ] **Step 1: Add the field and build it**

In `src/lib/receipt.ts`, add to the imports:

```ts
import { formatDayHours, rangesFor, weekdayKeyFor, type OpeningHours } from '@/lib/store-hours';
```

Add to `ReceiptData`, after `shopContactPhone`:

```ts
  // Today's hours only, pre-formatted. A whole week's table would dominate a
  // narrow receipt; today's line is what someone holding it wants. Null when
  // hours are unset or the shop is closed today.
  shopHours: string | null;
```

Add `openingHours` to the `shop` parameter's inline type in `buildReceiptData`, beside `returnPolicy`:

```ts
    openingHours?: OpeningHours;
```

It is optional so existing callers that build a receipt from a partial shop shape keep compiling; a missing value simply yields no hours line. The type comes from the import added in this step.

Add to the returned object, after `shopContactPhone`:

```ts
    shopHours: formatTodayHours(shop.openingHours),
```

Add the helper beside the existing `formatLocation`:

```ts
// Null rather than 'Closed' when the shop is shut today: a receipt is proof of
// a sale that just happened, so printing "Closed" on it would be absurd.
function formatTodayHours(hours: OpeningHours | undefined): string | null {
  if (!hours) return null;
  const today = rangesFor(hours, weekdayKeyFor(new Date()));
  if (today.length === 0) return null;
  const formatted = formatDayHours(today);
  return formatted === 'Closed' ? null : `Open today ${formatted}`;
}
```

- [ ] **Step 2: Render it in the plain-text receipt**

In `buildReceiptText`, after the `shopContactPhone` line:

```ts
  if (receipt.shopHours) lines.push(receipt.shopHours);
```

- [ ] **Step 3: Render it in the HTML receipt**

In the HTML template, after the `shopContactPhone` div:

```ts
      ${receipt.shopHours ? `<div class="muted">${esc(receipt.shopHours)}</div>` : ''}
```

- [ ] **Step 4: Render it in the on-screen receipt**

In `src/components/receipt-modal.tsx`, after the `shopContactPhone` line (around line 164):

```tsx
                {receipt.shopHours && <Text style={styles.muted}>{receipt.shopHours}</Text>}
```

- [ ] **Step 5: Confirm every renderer was updated**

Run: `grep -n "shopContactPhone" src/lib/receipt.ts src/components/receipt-modal.tsx`

Expected: four hits — the type, the `buildReceiptData` assignment, the text renderer, the HTML renderer — plus one in `receipt-modal.tsx`. Every one of those sites except the type and the assignment should now have a `shopHours` line beside it. A missed renderer means the hours appear on a printed receipt but not an emailed one, which is the kind of inconsistency nobody notices until a customer asks.

- [ ] **Step 6: Verify**

Run: `npx jest && npx tsc --noEmit && npx expo lint`
Expected: `Test Suites: 15 passed`, `Tests: 305 passed`; no TypeScript output; lint at 42 problems.

- [ ] **Step 7: Commit**

```bash
git add src/lib/receipt.ts src/components/receipt-modal.tsx
git commit -m "feat: print today's opening hours on receipts

Today's line rather than a week's table -- a narrow receipt has no room
for seven rows, and today is what someone holding it wants.

Null rather than 'Closed' when the shop is shut today: a receipt is proof
of a sale that just happened, so printing Closed on it would be absurd."
```

---

## Done when

- `npx jest` reports 15 suites / 305 tests passing.
- `npx tsc --noEmit` and `npx expo lint` are clean (lint at its 42-problem baseline).
- `supabase db reset` applies the whole chain from scratch.
- Settings → Store shows seven weekday rows; setting Monday 09:00–18:00 and saving persists it.
- Entering `9:00` on a day blocks Save with a message naming that day.
- A receipt taken during opening hours shows `Open today 09:00 – 18:00` on screen, in the printed HTML, and in the plain-text version.

## Deliberately not done here

- **Holiday and one-off overrides.** A second table plus rules for which wins on a date. Purely additive later.
- **Per-location hours.** Would move the column off `shops`; multi-location touches far more than hours.
- **POS enforcement.** Warning or blocking a sale outside hours needs its own thinking about override.
- **Overnight ranges** crossing midnight. Rejected at entry rather than silently mis-stored.
- **A second range per day in the editor.** The stored shape already supports it and Task 1 tests it; only the UI is deferred.
- **`supabase db push`.** Local verification only; applying to production is a separate, deliberate act.
