# Team Scheduling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a shop owner say who works when — a week view of shifts, an editor that catches the obvious mistakes, and each member's own shifts on their self-service screen.

**Architecture:** One `shifts` table with `'HH:MM'` wall-clock times, matching the convention `opening_hours` already uses. A pure `src/lib/scheduling.ts` owns validation and week arithmetic; `src/lib/shifts.ts` is data access; the UI is a fourth tab on the People screen plus a section on `/me`.

**Tech Stack:** Expo SDK 57, React Native 0.86, React 19.2, TypeScript 6.0, Jest 29 (`jest-expo`, TZ pinned to `America/New_York`), Supabase/Postgres 17.

**Spec:** `docs/superpowers/specs/2026-08-03-team-scheduling-design.md`

## Global Constraints

- **Expo SDK 57.** Per `AGENTS.md`, consult https://docs.expo.dev/versions/v57.0.0/ before writing framework code. The UI tasks use only primitives already used in `people.tsx`.
- **Times are `'HH:MM'` local wall-clock strings**, zero-padded, 24-hour — the same convention as `opening_hours`. Never a timestamp, never UTC.
- **Because times are zero-padded fixed-width, plain string comparison is chronological.** `'09:00' < '13:00'` is true and correct. Use it rather than converting to minutes for ordering and overlap.
- **A shift starting exactly when another ends does NOT overlap.** 09:00–13:00 and 13:00–17:00 are both valid, mirroring the exclusive-close convention `isOpenAt` uses.
- **Day arithmetic uses calendar components** — `new Date(y, m, d + n)`. Never add `n * 86400000` milliseconds: across a DST boundary that lands at 23:00 the previous day. That bug reached this project's accrual code once already.
- **`src/lib/scheduling.ts` imports no Supabase**, so it loads under Jest. `@/lib/store-hours` and `@/lib/period` are both safe (store-hours has zero imports; period has none either).
- **`npx jest`** baseline **15 suites / 320 tests**. `jest.config.js` pins `process.env.TZ = 'America/New_York'` — do not remove it.
- **`npx tsc --noEmit`** clean; **`npx expo lint`** has **42 known pre-existing problems (38 errors, 4 warnings)** and must gain none. Several are `react-hooks/set-state-in-effect` — prefer handlers over effects that set state.
- **Database work is local only.** Stack is running; `DB_URL` is `postgresql://postgres:postgres@127.0.0.1:54322/postgres`. **Never run `supabase db push`** — the remote is production and currently fully in sync.
- **Migration versions must sort after `20260805000000`**, the current latest.

---

### Task 1: `scheduling.ts` — validation and week arithmetic

All the logic, with real tests. Tasks 2-6 are consumers.

**Files:**
- Create: `src/lib/scheduling.ts`
- Create: `src/lib/__tests__/scheduling.test.ts`

**Interfaces:**
- Consumes: `isConfigured`, `isRangeWithinHours`, `weekdayKeyFor`, `OpeningHours` from `@/lib/store-hours`; `fromDateColumn`, `toDateColumn` from `@/lib/period`.
- Produces, relied on by Tasks 2–6:
  ```ts
  type ShiftDraft = { shopMemberId: string; date: string; start: string; end: string }
  type Shift = ShiftDraft & { id: string; shopId: string; note: string | null }
  type ShiftProblem = { kind: 'overlap' | 'outside_hours' | 'on_leave'; blocking: boolean; message: string }
  type ValidationContext = { hours: OpeningHours; onLeave: Set<string>; sameDayShifts: Shift[] }
  validateShift(draft: ShiftDraft, context: ValidationContext): ShiftProblem[]
  hasBlockingProblem(problems: ShiftProblem[]): boolean
  shiftMinutes(draft: ShiftDraft): number
  startOfWeek(date: string): string
  weekDaysFrom(monday: string): string[]
  addDaysToDate(date: string, days: number): string
  shiftsToCopy(previous: Shift[], existing: Shift[]): { copy: ShiftDraft[]; skipped: number }
  ```

- [ ] **Step 1: Write the failing tests**

Create `src/lib/__tests__/scheduling.test.ts`:

```ts
import {
  addDaysToDate,
  hasBlockingProblem,
  shiftMinutes,
  shiftsToCopy,
  startOfWeek,
  validateShift,
  weekDaysFrom,
  type Shift,
  type ValidationContext,
} from '@/lib/scheduling';
import type { OpeningHours } from '@/lib/store-hours';

// 2026-08-03 is a Monday.
const MONDAY = '2026-08-03';

const OPEN_9_TO_6: OpeningHours = {
  mon: [{ open: '09:00', close: '18:00' }],
  tue: [{ open: '09:00', close: '18:00' }],
};

function makeShift(overrides: Partial<Shift> = {}): Shift {
  return {
    id: 's1',
    shopId: 'shop1',
    shopMemberId: 'm1',
    date: MONDAY,
    start: '09:00',
    end: '13:00',
    note: null,
    ...overrides,
  };
}

function context(overrides: Partial<ValidationContext> = {}): ValidationContext {
  return { hours: OPEN_9_TO_6, onLeave: new Set<string>(), sameDayShifts: [], ...overrides };
}

describe('validateShift — overlap', () => {
  it('blocks a shift overlapping another for the same member that day', () => {
    const problems = validateShift(
      { shopMemberId: 'm1', date: MONDAY, start: '12:00', end: '17:00' },
      context({ sameDayShifts: [makeShift()] })
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ kind: 'overlap', blocking: true });
  });

  // The boundary rule: back-to-back shifts are normal and must be allowed.
  it('allows a shift starting exactly when another ends', () => {
    const problems = validateShift(
      { shopMemberId: 'm1', date: MONDAY, start: '13:00', end: '17:00' },
      context({ sameDayShifts: [makeShift()] })
    );
    expect(problems).toEqual([]);
  });

  it('ignores a shift belonging to a different member', () => {
    const problems = validateShift(
      { shopMemberId: 'm2', date: MONDAY, start: '12:00', end: '17:00' },
      context({ sameDayShifts: [makeShift({ shopMemberId: 'm1' })] })
    );
    expect(problems).toEqual([]);
  });

  it('ignores a shift on a different day', () => {
    const problems = validateShift(
      { shopMemberId: 'm1', date: '2026-08-04', start: '09:00', end: '13:00' },
      context({ sameDayShifts: [makeShift({ date: MONDAY })] })
    );
    expect(problems).toEqual([]);
  });
});

describe('validateShift — opening hours', () => {
  it('warns when the shift falls outside opening hours', () => {
    const problems = validateShift(
      { shopMemberId: 'm1', date: MONDAY, start: '07:00', end: '10:00' },
      context()
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ kind: 'outside_hours', blocking: false });
  });

  it('does not warn for a shift inside opening hours', () => {
    const problems = validateShift({ shopMemberId: 'm1', date: MONDAY, start: '09:00', end: '18:00' }, context());
    expect(problems).toEqual([]);
  });

  // opening_hours defaults to {} with no backfill, so without this guard every
  // shop that never opened Settings would warn on every shift it ever created.
  it('skips the hours check entirely when the shop has no hours configured', () => {
    const problems = validateShift(
      { shopMemberId: 'm1', date: MONDAY, start: '03:00', end: '05:00' },
      context({ hours: {} })
    );
    expect(problems).toEqual([]);
  });

  it('warns on a day the shop is closed', () => {
    const problems = validateShift(
      { shopMemberId: 'm1', date: '2026-08-09', start: '09:00', end: '13:00' },
      context()
    );
    expect(problems[0]).toMatchObject({ kind: 'outside_hours' });
  });
});

describe('validateShift — leave', () => {
  it('warns when the member has approved leave that day', () => {
    const problems = validateShift(
      { shopMemberId: 'm1', date: MONDAY, start: '09:00', end: '13:00' },
      context({ onLeave: new Set(['m1']) })
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ kind: 'on_leave', blocking: false });
  });

  it('reports an overlap and leave together', () => {
    const problems = validateShift(
      { shopMemberId: 'm1', date: MONDAY, start: '12:00', end: '17:00' },
      context({ onLeave: new Set(['m1']), sameDayShifts: [makeShift()] })
    );
    expect(problems.map((p) => p.kind).sort()).toEqual(['on_leave', 'overlap']);
  });
});

describe('hasBlockingProblem', () => {
  it('is true only when something blocking is present', () => {
    expect(hasBlockingProblem([{ kind: 'on_leave', blocking: false, message: 'x' }])).toBe(false);
    expect(hasBlockingProblem([{ kind: 'overlap', blocking: true, message: 'x' }])).toBe(true);
    expect(hasBlockingProblem([])).toBe(false);
  });
});

describe('shiftMinutes', () => {
  it('measures the shift in minutes', () => {
    expect(shiftMinutes({ shopMemberId: 'm1', date: MONDAY, start: '09:00', end: '13:30' })).toBe(270);
  });
});

describe('startOfWeek and weekDaysFrom', () => {
  it('returns the Monday of a mid-week date', () => {
    expect(startOfWeek('2026-08-06')).toBe('2026-08-03');
  });

  it('treats Monday as its own week start', () => {
    expect(startOfWeek(MONDAY)).toBe(MONDAY);
  });

  // Date.getDay() returns 0 for Sunday, so Sunday belongs to the week that
  // began six days earlier, not to the one starting the next day.
  it('puts Sunday in the week that started the preceding Monday', () => {
    expect(startOfWeek('2026-08-09')).toBe(MONDAY);
  });

  it('crosses a month boundary', () => {
    expect(startOfWeek('2026-09-02')).toBe('2026-08-31');
  });

  it('crosses a year boundary', () => {
    expect(startOfWeek('2027-01-01')).toBe('2026-12-28');
  });

  it('returns seven consecutive days from the Monday', () => {
    expect(weekDaysFrom(MONDAY)).toEqual([
      '2026-08-03',
      '2026-08-04',
      '2026-08-05',
      '2026-08-06',
      '2026-08-07',
      '2026-08-08',
      '2026-08-09',
    ]);
  });

  it('spans a month end', () => {
    expect(weekDaysFrom('2026-08-31')[6]).toBe('2026-09-06');
  });
});

describe('addDaysToDate', () => {
  it('steps forward across a month boundary', () => {
    expect(addDaysToDate('2026-08-28', 7)).toBe('2026-09-04');
  });

  it('steps backward', () => {
    expect(addDaysToDate('2026-08-03', -7)).toBe('2026-07-27');
  });

  it('handles a leap day', () => {
    expect(addDaysToDate('2024-02-28', 1)).toBe('2024-02-29');
  });
});

describe('shiftsToCopy', () => {
  it('shifts every date forward by a week', () => {
    const { copy, skipped } = shiftsToCopy([makeShift()], []);
    expect(skipped).toBe(0);
    expect(copy).toEqual([{ shopMemberId: 'm1', date: '2026-08-10', start: '09:00', end: '13:00' }]);
  });

  it('skips one that would clash with a shift already there', () => {
    const existing = [makeShift({ id: 'e1', date: '2026-08-10', start: '12:00', end: '17:00' })];
    const { copy, skipped } = shiftsToCopy([makeShift()], existing);
    expect(copy).toEqual([]);
    expect(skipped).toBe(1);
  });

  // Two source shifts landing on the same slot must not both copy: the second
  // has to see the first, which isn't in `existing` yet.
  it('skips a clash against another shift it is about to copy', () => {
    const previous = [makeShift({ id: 's1' }), makeShift({ id: 's2', start: '12:00', end: '17:00' })];
    const { copy, skipped } = shiftsToCopy(previous, []);
    expect(copy).toHaveLength(1);
    expect(skipped).toBe(1);
  });

  it('copies a same-day shift for a different member', () => {
    const previous = [makeShift({ id: 's1' }), makeShift({ id: 's2', shopMemberId: 'm2' })];
    const { copy } = shiftsToCopy(previous, []);
    expect(copy).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest src/lib/__tests__/scheduling.test.ts`
Expected: FAIL — `Cannot find module '@/lib/scheduling'`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/scheduling.ts`:

```ts
import { fromDateColumn, toDateColumn } from '@/lib/period';
import { isConfigured, isRangeWithinHours, weekdayKeyFor, type OpeningHours } from '@/lib/store-hours';

// Shift validation and week arithmetic.
//
// Pure -- no Supabase import -- so it loads under Jest like store-hours.ts and
// pay-periods.ts. The week view and the shift editor are thin consumers, which
// is deliberate: there is no React Native testing library in this repo, so
// logic in a component is logic no test can reach.

export type ShiftDraft = { shopMemberId: string; date: string; start: string; end: string };

export type Shift = ShiftDraft & { id: string; shopId: string; note: string | null };

export type ShiftProblem = {
  kind: 'overlap' | 'outside_hours' | 'on_leave';
  // Only an overlap blocks. The other two are legitimate often enough to inform
  // rather than forbid: a stock-take before opening is a real shift, and leave
  // gets rearranged. Same split as the payroll draft warnings.
  blocking: boolean;
  message: string;
};

export type ValidationContext = {
  hours: OpeningHours;
  // Members on approved leave ON THE SHIFT'S DATE -- built by the caller with
  // onLeaveMemberIds() from shift-hours.ts, which already handles
  // non-contiguous ranges.
  onLeave: Set<string>;
  // Every shift already stored for the shift's date, any member.
  sameDayShifts: Shift[];
};

// Times are zero-padded fixed-width 'HH:MM', so string comparison is
// chronological and needs no conversion to minutes.
//
// Touching at the boundary is NOT an overlap: 09:00-13:00 and 13:00-17:00 are
// both valid, which is how back-to-back shifts work and mirrors the
// exclusive-close convention in store-hours.
function overlaps(a: { start: string; end: string }, b: { start: string; end: string }): boolean {
  return a.start < b.end && b.start < a.end;
}

function toMinutes(time: string): number {
  const [hours, minutes] = time.split(':').map(Number);
  return hours * 60 + minutes;
}

// Stepping by whole local days. Deliberately NOT `time + n * 86400000`: across
// a daylight-saving boundary that lands at 23:00 the previous day, and
// toDateColumn would then report the wrong date.
export function addDaysToDate(date: string, days: number): string {
  const parsed = fromDateColumn(date);
  return toDateColumn(new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate() + days));
}

export function validateShift(draft: ShiftDraft, context: ValidationContext): ShiftProblem[] {
  const problems: ShiftProblem[] = [];

  const clash = context.sameDayShifts.find(
    (other) => other.shopMemberId === draft.shopMemberId && other.date === draft.date && overlaps(draft, other)
  );
  if (clash) {
    problems.push({
      kind: 'overlap',
      blocking: true,
      message: `Overlaps an existing ${clash.start}–${clash.end} shift for this person.`,
    });
  }

  // Skipped entirely when the shop has never set hours. opening_hours defaults
  // to {} with no backfill, so without this guard every shop that hasn't opened
  // Settings would warn on every shift it ever created.
  if (isConfigured(context.hours)) {
    const day = weekdayKeyFor(fromDateColumn(draft.date));
    if (!isRangeWithinHours(context.hours, day, { open: draft.start, close: draft.end })) {
      problems.push({
        kind: 'outside_hours',
        blocking: false,
        message: 'Outside the shop’s opening hours for that day.',
      });
    }
  }

  if (context.onLeave.has(draft.shopMemberId)) {
    problems.push({
      kind: 'on_leave',
      blocking: false,
      message: 'This person has approved time off that day.',
    });
  }

  return problems;
}

export function hasBlockingProblem(problems: ShiftProblem[]): boolean {
  return problems.some((problem) => problem.blocking);
}

export function shiftMinutes(draft: ShiftDraft): number {
  return toMinutes(draft.end) - toMinutes(draft.start);
}

// The Monday of the week containing `date`. Date.getDay() returns 0 for Sunday,
// so Sunday belongs to the week that began six days earlier.
export function startOfWeek(date: string): string {
  const parsed = fromDateColumn(date);
  const dayOfWeek = parsed.getDay();
  const daysBack = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  return addDaysToDate(date, -daysBack);
}

export function weekDaysFrom(monday: string): string[] {
  return Array.from({ length: 7 }, (_, index) => addDaysToDate(monday, index));
}

// Every shift from the previous week, moved forward seven days -- except any
// that would clash with something already there. Reports the skipped count
// rather than silently doing partial work or refusing the whole operation
// because of one clash.
export function shiftsToCopy(previous: Shift[], existing: Shift[]): { copy: ShiftDraft[]; skipped: number } {
  const copy: ShiftDraft[] = [];
  let skipped = 0;

  for (const shift of previous) {
    const draft: ShiftDraft = {
      shopMemberId: shift.shopMemberId,
      date: addDaysToDate(shift.date, 7),
      start: shift.start,
      end: shift.end,
    };

    // Checked against what is already stored AND against what this run has
    // already queued -- two source shifts can land on the same slot, and the
    // second one cannot see the first in `existing`.
    const clashes = (candidate: { shopMemberId: string; date: string; start: string; end: string }) =>
      candidate.shopMemberId === draft.shopMemberId && candidate.date === draft.date && overlaps(candidate, draft);

    if (existing.some(clashes) || copy.some(clashes)) {
      skipped += 1;
      continue;
    }
    copy.push(draft);
  }

  return { copy, skipped };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest src/lib/__tests__/scheduling.test.ts`
Expected: PASS, 26 tests.

- [ ] **Step 5: Full suite and typecheck**

Run: `npx jest && npx tsc --noEmit`
Expected: `Test Suites: 16 passed, 16 total`, `Tests: 346 passed` (320 + 26). No TypeScript output.

- [ ] **Step 6: Commit**

```bash
git add src/lib/scheduling.ts src/lib/__tests__/scheduling.test.ts
git commit -m "feat: add scheduling module — shift validation and week arithmetic

All the logic lives here with real tests, because the week view and the
editor can't have any: there is no React Native testing library in this
repo.

Only an overlap blocks. Outside-hours and on-leave inform instead -- a
stock-take before opening is a real shift, and leave gets rearranged.

The hours check is skipped when the shop has no hours configured.
opening_hours defaults to {} with no backfill, so without that guard
every shop that never opened Settings would warn on every shift."
```

---

### Task 2: The table, the permission, and RLS

**Files:**
- Create: `supabase/migrations/20260806000000_shifts.sql`
- Modify: `src/lib/permissions.ts` (the `Permission` union and the `PERMISSIONS` catalogue)
- Modify: `src/lib/permission-groups.ts` (the People group)

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces, relied on by Tasks 3–6: the `shifts` table, and the permission key `'people.schedule.manage'`.

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/20260806000000_shifts.sql`:

```sql
-- Who works when. The app recorded what already happened -- time_entries for
-- clocked hours, time_off_requests for approved leave -- but had no way to say
-- what is going to happen, so an owner couldn't tell staff when to come in and
-- staff couldn't look up their own next shift.
--
-- Times are 'HH:MM' local wall-clock text, the same convention opening_hours
-- uses: a shift at 09:00 is at 09:00 regardless of daylight saving or the
-- viewer's device. Zero-padding makes the lexicographic end > start comparison
-- correct, and one representation runs from here to the UI.
--
-- Format CHECKs are included here although they were declined for
-- shops.opening_hours. That is not inconsistency: this is a one-line regex on a
-- scalar column, not a recursive JSONB shape constraint that would need
-- rewriting the moment the shape gains split shifts.
--
-- Overnight shifts crossing midnight are rejected, the same limitation opening
-- hours has and for the same reason: an end before a start is more often a typo
-- than an intention.

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

-- The week view queries one shop's shifts for a seven-day range; /me queries
-- one member's upcoming shifts.
create index shifts_shop_date_idx on public.shifts(shop_id, shift_date);
create index shifts_member_date_idx on public.shifts(shop_member_id, shift_date);

alter table public.shifts enable row level security;

-- Reading your own shifts needs no permission -- that is what makes the /me
-- view work for an ordinary cashier, and it mirrors the existing
-- "staff reads own membership" policy on shop_members.
create policy "read own shifts" on public.shifts for select
  using (exists (
    select 1 from public.shop_members m
    where m.id = shop_member_id and m.user_id = auth.uid()
  ));

create policy "read shop shifts" on public.shifts for select
  using (has_shop_permission(shop_id, 'people.schedule.manage'));

create policy "write shop shifts" on public.shifts for all
  using (has_shop_permission(shop_id, 'people.schedule.manage'))
  with check (has_shop_permission(shop_id, 'people.schedule.manage'));

grant select, insert, update, delete on public.shifts to authenticated;
```

- [ ] **Step 2: Apply locally and confirm the chain builds from scratch**

Run: `supabase db reset`
Expected: ends `Finished supabase db reset.` with no error.

- [ ] **Step 3: Add the permission**

In `src/lib/permissions.ts`, add to the `Permission` union after `'people.timesheet.view'`:

```ts
  | 'people.schedule.manage'
```

and to the `PERMISSIONS` array after the `people.timesheet.view` entry:

```ts
  { key: 'people.schedule.manage', label: 'Manage the schedule', description: "Create and change shifts for the whole team. Everyone can see their own shifts without this." },
```

In `src/lib/permission-groups.ts`, add `'people.schedule.manage'` to the People group's `permissions` array.

- [ ] **Step 4: Prove the RLS actually protects staff privacy**

The policies are the only thing stopping one cashier reading a colleague's rota, and no unit test can reach them. Add this to `supabase/tests/verify-accounting-writes.sql`, immediately before the final `raise notice` that prints `ALL CHECKS PASSED`:

```sql
  ------------------------------------------------------------------
  raise notice '=== 8. Shifts: a member reads their own, not a colleague''s ===';
  ------------------------------------------------------------------
  declare
    v_mate_user uuid := gen_random_uuid();
    v_mate_id uuid;
    v_mine_id uuid;
    v_theirs_id uuid;
    v_seen integer;
  begin
    -- A second member, with their own auth user (shop_members is unique on
    -- (shop_id, user_id), and user_id references auth.users).
    insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
      values (v_mate_user, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
              'verify-' || v_mate_user || '@example.test', '', now(), now(), now());
    insert into public.shop_members (shop_id, user_id, role_id, active, full_name)
      values (v_shop_id, v_mate_user, v_role_id, true, 'Rota Mate')
      returning id into v_mate_id;

    insert into public.shifts (shop_id, shop_member_id, shift_date, start_time, end_time)
      values (v_shop_id, v_member_id, '2026-08-03', '09:00', '17:00') returning id into v_mine_id;
    insert into public.shifts (shop_id, shop_member_id, shift_date, start_time, end_time)
      values (v_shop_id, v_mate_id, '2026-08-03', '09:00', '17:00') returning id into v_theirs_id;

    -- The role created earlier holds only expenses.manage, so this member has
    -- no people.schedule.manage and must fall back to the own-rows policy.
    set local role authenticated;
    perform set_config('request.jwt.claims', json_build_object('sub', v_user_id)::text, true);

    select count(*) into v_seen from public.shifts where id = v_mine_id;
    if v_seen <> 1 then raise exception 'FAIL: a member cannot read their own shift'; end if;

    select count(*) into v_seen from public.shifts where id = v_theirs_id;
    if v_seen <> 0 then raise exception 'FAIL: a member read a colleague''s shift without people.schedule.manage'; end if;

    v_raised := false;
    begin
      insert into public.shifts (shop_id, shop_member_id, shift_date, start_time, end_time)
        values (v_shop_id, v_member_id, '2026-08-04', '09:00', '17:00');
    exception when others then
      v_raised := true;
    end;
    if not v_raised then raise exception 'FAIL: a member wrote a shift without people.schedule.manage'; end if;

    reset role;
    raise notice 'OK: own shift readable, colleague''s hidden, writes refused';
  end;
```

Note `reset role;` at the end — the surrounding script runs as superuser with RLS bypassed (see its line 114), so this block has to opt *into* RLS and then hand the role back, or every later check runs under the wrong identity.

- [ ] **Step 5: Run the database tests**

Run:
```bash
supabase db reset && psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -f supabase/tests/verify-accounting-writes.sql
```
Expected: ends `################  ALL CHECKS PASSED  ################` and `Rolled back — no rows left behind.`, including the new `OK: own shift readable…` line.

If it fails at "a member read a colleague's shift", the `read shop shifts` policy is matching when it should not — check that `has_shop_permission` is being given `'people.schedule.manage'` and not a permission this test's role happens to hold.

- [ ] **Step 6: Verify**

Run: `npx jest && npx tsc --noEmit && npx expo lint`
Expected: `Test Suites: 16 passed`, `Tests: 346 passed` (unchanged); no TypeScript output; lint at 42 problems.

- [ ] **Step 7: Commit**

```bash
git add supabase/migrations/20260806000000_shifts.sql src/lib/permissions.ts src/lib/permission-groups.ts supabase/tests/verify-accounting-writes.sql
git commit -m "feat: add the shifts table and the schedule permission

Reading your own shifts needs no permission -- that is what makes the /me
view work for an ordinary cashier, mirroring the existing 'staff reads
own membership' policy. Seeing everyone's, and writing any, needs
people.schedule.manage.

Format CHECKs are included here having been declined for
shops.opening_hours: a one-line regex on a scalar is not a recursive
JSONB shape constraint that would need rewriting."
```

---

### Task 3: Data access

**Files:**
- Create: `src/lib/shifts.ts`

**Interfaces:**
- Consumes: `Shift`, `ShiftDraft` from `@/lib/scheduling` (Task 1); the `shifts` table from Task 2.
- Produces, relied on by Tasks 4–6:
  ```ts
  listShiftsForWeek(shopId: string, monday: string): Promise<Shift[]>
  listMyShifts(shopMemberId: string, fromDate: string): Promise<Shift[]>
  createShift(shopId: string, draft: ShiftDraft, note: string | null): Promise<Shift>
  updateShift(id: string, patch: { date?: string; start?: string; end?: string; note?: string | null }): Promise<void>
  deleteShift(id: string): Promise<void>
  createShifts(shopId: string, drafts: ShiftDraft[]): Promise<number>
  ```

- [ ] **Step 1: Write the module**

Create `src/lib/shifts.ts`:

```ts
import { addDaysToDate, type Shift, type ShiftDraft } from '@/lib/scheduling';
import { supabase } from '@/lib/supabase';

// Data access for shifts. The validation and week arithmetic live in
// scheduling.ts so they stay testable without the Supabase client.

function mapShiftRow(row: any): Shift {
  return {
    id: row.id,
    shopId: row.shop_id,
    shopMemberId: row.shop_member_id,
    date: row.shift_date,
    start: row.start_time,
    end: row.end_time,
    note: row.note,
  };
}

// Sunday is the seventh day, so the range ends six days after the Monday.
export async function listShiftsForWeek(shopId: string, monday: string): Promise<Shift[]> {
  const { data, error } = await supabase
    .from('shifts')
    .select('*')
    .eq('shop_id', shopId)
    .gte('shift_date', monday)
    .lte('shift_date', addDaysToDate(monday, 6))
    .order('shift_date', { ascending: true })
    .order('start_time', { ascending: true });
  if (error) throw error;
  return (data ?? []).map(mapShiftRow);
}

// The /me view. Goes through the "read own shifts" policy, so it needs no
// permission -- an ordinary cashier can see their own rota.
export async function listMyShifts(shopMemberId: string, fromDate: string): Promise<Shift[]> {
  const { data, error } = await supabase
    .from('shifts')
    .select('*')
    .eq('shop_member_id', shopMemberId)
    .gte('shift_date', fromDate)
    .order('shift_date', { ascending: true })
    .order('start_time', { ascending: true });
  if (error) throw error;
  return (data ?? []).map(mapShiftRow);
}

export async function createShift(shopId: string, draft: ShiftDraft, note: string | null): Promise<Shift> {
  const { data: userData } = await supabase.auth.getUser();
  const { data, error } = await supabase
    .from('shifts')
    .insert({
      shop_id: shopId,
      shop_member_id: draft.shopMemberId,
      shift_date: draft.date,
      start_time: draft.start,
      end_time: draft.end,
      note,
      created_by: userData.user?.id ?? null,
    })
    .select('*')
    .single();
  if (error) throw error;
  return mapShiftRow(data);
}

export async function updateShift(
  id: string,
  patch: { date?: string; start?: string; end?: string; note?: string | null }
): Promise<void> {
  const { error, count } = await supabase
    .from('shifts')
    .update(
      {
        ...(patch.date !== undefined && { shift_date: patch.date }),
        ...(patch.start !== undefined && { start_time: patch.start }),
        ...(patch.end !== undefined && { end_time: patch.end }),
        ...(patch.note !== undefined && { note: patch.note }),
        updated_at: new Date().toISOString(),
      },
      { count: 'exact' }
    )
    .eq('id', id);
  if (error) throw error;
  // RLS filters an update to zero rows without raising, so without the count a
  // policy-blocked write reads as success -- same guard as updateStaffPay.
  if (count === 0) throw new Error('Could not save this shift — you may no longer have permission to change the schedule.');
}

export async function deleteShift(id: string): Promise<void> {
  const { error, count } = await supabase.from('shifts').delete({ count: 'exact' }).eq('id', id);
  if (error) throw error;
  if (count === 0) throw new Error('Could not delete this shift — you may no longer have permission to change the schedule.');
}

// Copy-last-week writes its whole batch in one insert. Returns how many rows
// landed so the caller can report it alongside the skipped count.
export async function createShifts(shopId: string, drafts: ShiftDraft[]): Promise<number> {
  if (drafts.length === 0) return 0;
  const { data: userData } = await supabase.auth.getUser();
  const { data, error } = await supabase
    .from('shifts')
    .insert(
      drafts.map((draft) => ({
        shop_id: shopId,
        shop_member_id: draft.shopMemberId,
        shift_date: draft.date,
        start_time: draft.start,
        end_time: draft.end,
        created_by: userData.user?.id ?? null,
      }))
    )
    .select('id');
  if (error) throw error;
  return (data ?? []).length;
}
```

- [ ] **Step 2: Verify**

Run: `npx jest && npx tsc --noEmit && npx expo lint`
Expected: `Test Suites: 16 passed`, `Tests: 346 passed` (unchanged — this file imports Supabase and is therefore outside the Jest suite, by the same rule that keeps the pure modules testable); no TypeScript output; lint at 42 problems.

- [ ] **Step 3: Commit**

```bash
git add src/lib/shifts.ts
git commit -m "feat: add shift data access

listMyShifts goes through the 'read own shifts' policy, so an ordinary
cashier can see their own rota without the schedule permission.

update and delete ask for an exact count and throw on zero rows: RLS
filters a write silently, and without the count a policy-blocked change
reads as success -- the same guard updateStaffPay carries."
```

---

### Task 4: The Schedule tab — week view

Read-only display plus week navigation. Task 5 adds mutation.

**Files:**
- Create: `src/components/schedule/schedule-tab.tsx`
- Modify: `src/app/(admin)/(tabs)/people.tsx` — the `PeopleTab` union, the permission check, the tab options, and the tab body

**Interfaces:**
- Consumes: `listShiftsForWeek` from `@/lib/shifts` (Task 3); `startOfWeek`, `weekDaysFrom`, `addDaysToDate`, `shiftMinutes`, `Shift` from `@/lib/scheduling` (Task 1); `listStaff` from `@/lib/staff`.
- Produces, relied on by Task 5: the `ScheduleTab` component and its `reload` behaviour.

No automated coverage is possible — there is no React Native testing library. Verified by typecheck, lint and reading.

- [ ] **Step 1: Create the week view**

Create `src/components/schedule/schedule-tab.tsx`:

```tsx
import { useCallback, useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';

import { useAuth } from '@/hooks/use-auth';
import { addDaysToDate, shiftMinutes, startOfWeek, weekDaysFrom, type Shift } from '@/lib/scheduling';
import { listShiftsForWeek } from '@/lib/shifts';
import { listStaff } from '@/lib/staff';
import { toDateColumn } from '@/lib/period';
import type { StaffMember } from '@/types/models';

const TABLET_BREAKPOINT = 768;

function dayLabel(date: string): string {
  const [, month, day] = date.split('-');
  return `${day}/${month}`;
}

function totalHours(shifts: Shift[]): string {
  const minutes = shifts.reduce((sum, shift) => sum + shiftMinutes(shift), 0);
  return `${(minutes / 60).toFixed(minutes % 60 === 0 ? 0 : 1)}h`;
}

export function ScheduleTab({ tabSwitcher }: { tabSwitcher: React.ReactNode }) {
  const { shop } = useAuth();
  const { width } = useWindowDimensions();
  const compact = width < TABLET_BREAKPOINT;

  const [monday, setMonday] = useState(() => startOfWeek(toDateColumn(new Date())));
  const [shifts, setShifts] = useState<Shift[]>([]);
  const [members, setMembers] = useState<StaffMember[]>([]);
  const [selectedDay, setSelectedDay] = useState(() => toDateColumn(new Date()));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!shop) return;
    setLoading(true);
    try {
      const [weekShifts, staff] = await Promise.all([listShiftsForWeek(shop.id, monday), listStaff(shop.id)]);
      setShifts(weekShifts);
      setMembers(staff.filter((member) => member.active));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load the schedule.');
    } finally {
      setLoading(false);
    }
  }, [shop, monday]);

  useEffect(() => { reload(); }, [reload]);

  const days = weekDaysFrom(monday);
  const shiftsFor = (memberId: string, date: string) =>
    shifts.filter((shift) => shift.shopMemberId === memberId && shift.date === date);

  return (
    <View>
      <View style={styles.header}>
        <Text style={styles.title}>Schedule</Text>
        <View style={styles.weekNav}>
          <Pressable onPress={() => setMonday(addDaysToDate(monday, -7))} style={styles.navButton}>
            <Text style={styles.navText}>‹</Text>
          </Pressable>
          <Text style={styles.weekLabel}>{dayLabel(days[0])} – {dayLabel(days[6])}</Text>
          <Pressable onPress={() => setMonday(addDaysToDate(monday, 7))} style={styles.navButton}>
            <Text style={styles.navText}>›</Text>
          </Pressable>
          <Pressable onPress={() => setMonday(startOfWeek(toDateColumn(new Date())))} style={styles.navButton}>
            <Text style={styles.navText}>Today</Text>
          </Pressable>
        </View>
      </View>
      {tabSwitcher}

      {error && <Text style={styles.error}>{error}</Text>}

      {loading ? (
        <Text style={styles.empty}>Loading…</Text>
      ) : members.length === 0 ? (
        <Text style={styles.empty}>No active staff to schedule.</Text>
      ) : compact ? (
        <>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.dayStrip}>
            {days.map((date) => (
              <Pressable key={date} onPress={() => setSelectedDay(date)} style={[styles.dayChip, selectedDay === date && styles.dayChipActive]}>
                <Text style={[styles.dayChipText, selectedDay === date && styles.dayChipTextActive]}>{dayLabel(date)}</Text>
              </Pressable>
            ))}
          </ScrollView>
          {members.map((member) => {
            const memberShifts = shiftsFor(member.id, selectedDay);
            return (
              <View key={member.id} style={styles.listRow}>
                <Text style={styles.memberName}>{member.fullName ?? 'Staff member'}</Text>
                <Text style={memberShifts.length === 0 ? styles.off : styles.times}>
                  {memberShifts.length === 0 ? 'Off' : memberShifts.map((s) => `${s.start}–${s.end}`).join(', ')}
                </Text>
              </View>
            );
          })}
        </>
      ) : (
        <ScrollView horizontal>
          <View>
            <View style={styles.gridRow}>
              <Text style={[styles.gridCell, styles.gridHeadCell]}>Staff</Text>
              {days.map((date) => (
                <Text key={date} style={[styles.gridCell, styles.gridHeadCell]}>{dayLabel(date)}</Text>
              ))}
              <Text style={[styles.gridCell, styles.gridHeadCell]}>Total</Text>
            </View>
            {members.map((member) => (
              <View key={member.id} style={styles.gridRow}>
                <Text style={[styles.gridCell, styles.memberName]}>{member.fullName ?? 'Staff member'}</Text>
                {days.map((date) => {
                  const cell = shiftsFor(member.id, date);
                  return (
                    <Text key={date} style={[styles.gridCell, cell.length === 0 && styles.off]}>
                      {cell.length === 0 ? '—' : cell.map((s) => `${s.start}–${s.end}`).join('\n')}
                    </Text>
                  );
                })}
                <Text style={[styles.gridCell, styles.total]}>
                  {totalHours(shifts.filter((shift) => shift.shopMemberId === member.id))}
                </Text>
              </View>
            ))}
          </View>
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 12, flexWrap: 'wrap' },
  title: { fontSize: 20, fontWeight: '800', color: '#111111' },
  weekNav: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  navButton: { backgroundColor: '#F2F2F2', borderRadius: 9, paddingHorizontal: 12, paddingVertical: 8 },
  navText: { fontSize: 13, fontWeight: '800', color: '#111111' },
  weekLabel: { fontSize: 13, fontWeight: '700', color: '#111111', minWidth: 104, textAlign: 'center' },
  dayStrip: { marginBottom: 12 },
  dayChip: { backgroundColor: '#F2F2F2', borderRadius: 999, paddingHorizontal: 14, paddingVertical: 8, marginRight: 8 },
  dayChipActive: { backgroundColor: '#111111' },
  dayChipText: { fontSize: 12, fontWeight: '700', color: '#444444' },
  dayChipTextActive: { color: '#FFFFFF' },
  listRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#F2F2F2' },
  gridRow: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: '#F2F2F2' },
  gridCell: { width: 104, padding: 10, fontSize: 12, color: '#111111' },
  gridHeadCell: { fontWeight: '800', color: '#999999', fontSize: 11 },
  memberName: { fontSize: 13, fontWeight: '700', color: '#111111' },
  times: { fontSize: 12, color: '#111111' },
  off: { color: '#999999' },
  total: { fontWeight: '800' },
  empty: { fontSize: 13, color: '#999999', paddingVertical: 24, textAlign: 'center' },
  error: { color: '#C0392B', fontSize: 13, fontWeight: '700', marginBottom: 12 },
});
```

Note the `useEffect(() => { reload(); }, [reload])` is the same pattern every other tab in this codebase uses and carries the same pre-existing `react-hooks/set-state-in-effect` finding. Confirm in Step 3 that lint reports 43, not 44 — one new instance of an already-accepted pattern is expected here; anything more is yours.

- [ ] **Step 2: Wire the tab into the People screen**

In `src/app/(admin)/(tabs)/people.tsx`:

Add the import:

```tsx
import { ScheduleTab } from '@/components/schedule/schedule-tab';
```

Change the tab union:

```tsx
type PeopleTab = 'customers' | 'team' | 'schedule' | 'me';
```

Add the permission check beside the existing ones:

```tsx
  const canSeeSchedule = can('people.schedule.manage');
```

Add to the `options` array, between Team and Me:

```tsx
    ...(canSeeSchedule ? [{ key: 'schedule' as const, label: 'Schedule' }] : []),
```

Add to the initial tab fallback chain and the tab body:

```tsx
  const [tab, setTab] = useState<PeopleTab>(canSeeCustomers ? 'customers' : canSeeTeam ? 'team' : canSeeSchedule ? 'schedule' : 'me');
```

```tsx
        {tab === 'schedule' && canSeeSchedule ? <ScheduleTab tabSwitcher={tabSwitcher} /> : null}
```

- [ ] **Step 3: Verify**

Run: `npx jest && npx tsc --noEmit && npx expo lint`
Expected: `Test Suites: 16 passed`, `Tests: 346 passed` (unchanged); no TypeScript output; lint at **43** problems (39 errors, 4 warnings) — one new `react-hooks/set-state-in-effect` from the `reload` effect, matching every other tab in this codebase.

Report the exact count. If it is 44 or more, you added something beyond that one accepted instance.

- [ ] **Step 4: Commit**

```bash
git add src/components/schedule/schedule-tab.tsx "src/app/(admin)/(tabs)/people.tsx"
git commit -m "feat: add the Schedule tab week view

A grid on tablet, a day strip and list on phone -- seven columns are
unusable at phone width, and people.tsx already branches on the tablet
breakpoint this way.

The tab is hidden without people.schedule.manage: a cashier would see
rows RLS blanks anyway, and sees their own shifts on /me instead."
```

---

### Task 5: The shift editor and copy last week

**Files:**
- Create: `src/components/schedule/shift-editor-modal.tsx`
- Modify: `src/components/schedule/schedule-tab.tsx`

**Interfaces:**
- Consumes: `validateShift`, `hasBlockingProblem`, `shiftsToCopy`, `addDaysToDate`, `Shift`, `ShiftDraft`, `ShiftProblem` from `@/lib/scheduling` (Task 1); `createShift`, `updateShift`, `deleteShift`, `createShifts`, `listShiftsForWeek` from `@/lib/shifts` (Task 3); `onLeaveMemberIds` from `@/lib/shift-hours`; `listShopTimeOffRequests` from `@/lib/time-off`.
- Produces: nothing consumed by Task 6.

- [ ] **Step 1: Create the editor modal**

Create `src/components/schedule/shift-editor-modal.tsx`:

```tsx
import { useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { CategoryChip } from '@/components/category-chip';
import { hasBlockingProblem, validateShift, type Shift, type ShiftProblem, type ValidationContext } from '@/lib/scheduling';
import { isValidTime } from '@/lib/store-hours';
import type { StaffMember } from '@/types/models';

// The editor is deliberately thin: every rule it enforces comes from
// validateShift in scheduling.ts, which is unit-tested. There is no React
// Native testing library here, so logic placed in this file would be logic no
// test can reach.

export function ShiftEditorModal({
  visible,
  date,
  members,
  existing,
  context,
  onClose,
  onSave,
  onDelete,
}: {
  visible: boolean;
  date: string;
  members: StaffMember[];
  existing: Shift | null;
  context: ValidationContext;
  onClose: () => void;
  onSave: (draft: { shopMemberId: string; date: string; start: string; end: string }, note: string | null) => Promise<void>;
  onDelete: () => Promise<void>;
}) {
  const [memberId, setMemberId] = useState(existing?.shopMemberId ?? members[0]?.id ?? '');
  const [start, setStart] = useState(existing?.start ?? '09:00');
  const [end, setEnd] = useState(existing?.end ?? '17:00');
  const [note, setNote] = useState(existing?.note ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!visible) return null;

  const timesValid = isValidTime(start) && isValidTime(end) && end > start;
  const draft = { shopMemberId: memberId, date, start, end };
  // Exclude the shift being edited, or it would always clash with itself.
  const problems: ShiftProblem[] = timesValid
    ? validateShift(draft, { ...context, sameDayShifts: context.sameDayShifts.filter((s) => s.id !== existing?.id) })
    : [];
  const blocked = !timesValid || !memberId || hasBlockingProblem(problems);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await onSave(draft, note.trim() || null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save this shift.');
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      await onDelete();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete this shift.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={styles.card}>
          <View style={styles.header}>
            <Text style={styles.title}>{existing ? 'Edit shift' : 'New shift'} · {date}</Text>
            <Pressable onPress={onClose} style={styles.close}>
              <Text style={styles.closeText}>Close</Text>
            </Pressable>
          </View>

          <Text style={styles.label}>STAFF</Text>
          <View style={styles.chips}>
            {members.map((member) => (
              <CategoryChip
                key={member.id}
                label={member.fullName ?? 'Staff member'}
                active={memberId === member.id}
                onPress={() => setMemberId(member.id)}
              />
            ))}
          </View>

          <View style={styles.timeRow}>
            <View style={styles.timeField}>
              <Text style={styles.label}>FROM</Text>
              <TextInput value={start} onChangeText={setStart} placeholder="09:00" placeholderTextColor="#999999" style={[styles.input, !isValidTime(start) && styles.inputInvalid]} />
            </View>
            <View style={styles.timeField}>
              <Text style={styles.label}>TO</Text>
              <TextInput value={end} onChangeText={setEnd} placeholder="17:00" placeholderTextColor="#999999" style={[styles.input, !isValidTime(end) && styles.inputInvalid]} />
            </View>
          </View>

          <Text style={styles.label}>NOTE (OPTIONAL)</Text>
          <TextInput value={note} onChangeText={setNote} placeholder="e.g. covering the delivery" placeholderTextColor="#999999" style={styles.input} />

          {!timesValid && <Text style={styles.blocking}>Use 24-hour times like 09:00, and end after you start.</Text>}
          {problems.map((problem) => (
            <Text key={problem.kind} style={problem.blocking ? styles.blocking : styles.advisory}>
              {problem.message}
            </Text>
          ))}
          {error && <Text style={styles.blocking}>{error}</Text>}

          <View style={styles.actions}>
            <Pressable onPress={save} disabled={busy || blocked} style={[styles.primary, (busy || blocked) && styles.disabled]}>
              <Text style={styles.primaryText}>{busy ? 'Saving…' : 'Save shift'}</Text>
            </Pressable>
            {existing && (
              <Pressable onPress={remove} disabled={busy}>
                <Text style={styles.danger}>Delete</Text>
              </Pressable>
            )}
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', alignItems: 'center', justifyContent: 'center', padding: 20 },
  card: { backgroundColor: '#FFFFFF', borderRadius: 18, padding: 20, width: '100%', maxWidth: 460 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 },
  title: { fontSize: 15, fontWeight: '800', color: '#111111', flexShrink: 1 },
  close: { backgroundColor: '#F2F2F2', borderRadius: 10, paddingHorizontal: 14, paddingVertical: 10 },
  closeText: { fontSize: 13, fontWeight: '700', color: '#111111' },
  label: { color: '#999999', fontSize: 10, fontWeight: '800', letterSpacing: 0.6, marginTop: 12, marginBottom: 6 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  timeRow: { flexDirection: 'row', gap: 12 },
  timeField: { flex: 1 },
  input: { backgroundColor: '#F2F2F2', height: 42, borderRadius: 10, paddingHorizontal: 12, color: '#111111' },
  inputInvalid: { borderWidth: 1, borderColor: '#C0392B', color: '#C0392B' },
  blocking: { color: '#C0392B', fontSize: 12, fontWeight: '700', marginTop: 10 },
  advisory: { color: '#B7791F', fontSize: 12, fontWeight: '600', marginTop: 10 },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 16, marginTop: 20 },
  primary: { backgroundColor: '#111111', borderRadius: 10, paddingVertical: 12, paddingHorizontal: 18 },
  primaryText: { color: '#FFFFFF', fontWeight: '800', fontSize: 13 },
  danger: { color: '#C0392B', fontWeight: '700', fontSize: 13 },
  disabled: { opacity: 0.5 },
});
```

- [ ] **Step 2: Wire the editor and copy-last-week into the tab**

In `src/components/schedule/schedule-tab.tsx`, add the imports:

```tsx
import { ShiftEditorModal } from '@/components/schedule/shift-editor-modal';
import { hasBlockingProblem, shiftsToCopy, type ShiftDraft } from '@/lib/scheduling';
import { createShift, createShifts, deleteShift, updateShift } from '@/lib/shifts';
import { onLeaveMemberIds } from '@/lib/shift-hours';
import { listShopTimeOffRequests } from '@/lib/time-off';
import { fromDateColumn } from '@/lib/period';
```

Add state and the leave/hours context:

```tsx
  const [editing, setEditing] = useState<{ date: string; shift: Shift | null } | null>(null);
  const [timeOff, setTimeOff] = useState<Awaited<ReturnType<typeof listShopTimeOffRequests>>>([]);
  const [copyNotice, setCopyNotice] = useState<string | null>(null);
```

Extend `reload` to fetch approved leave alongside the rest:

```tsx
      const [weekShifts, staff, requests] = await Promise.all([
        listShiftsForWeek(shop.id, monday),
        listStaff(shop.id),
        listShopTimeOffRequests(shop.id, { status: 'approved' }),
      ]);
      setShifts(weekShifts);
      setMembers(staff.filter((member) => member.active));
      setTimeOff(requests);
```

Add the handlers:

```tsx
  const saveShift = async (draft: ShiftDraft, note: string | null) => {
    if (!shop) return;
    if (editing?.shift) await updateShift(editing.shift.id, { date: draft.date, start: draft.start, end: draft.end, note });
    else await createShift(shop.id, draft, note);
    setEditing(null);
    await reload();
  };

  const removeShift = async () => {
    if (!editing?.shift) return;
    await deleteShift(editing.shift.id);
    setEditing(null);
    await reload();
  };

  // Reports both counts rather than silently doing partial work: an owner who
  // asked to copy a week needs to know which shifts didn't make it.
  const copyLastWeek = async () => {
    if (!shop) return;
    setCopyNotice(null);
    try {
      const previous = await listShiftsForWeek(shop.id, addDaysToDate(monday, -7));
      const { copy, skipped } = shiftsToCopy(previous, shifts);
      const created = await createShifts(shop.id, copy);
      setCopyNotice(
        skipped === 0
          ? `Copied ${created} shift${created === 1 ? '' : 's'} from last week.`
          : `Copied ${created}, skipped ${skipped} that clashed with a shift already here.`
      );
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not copy last week.');
    }
  };
```

Add the Copy last week button to the `weekNav` block, after the Today button:

```tsx
          <Pressable onPress={copyLastWeek} style={styles.navButton}>
            <Text style={styles.navText}>Copy last week</Text>
          </Pressable>
```

Render the notice immediately after `{error && …}`:

```tsx
      {copyNotice && <Text style={styles.notice}>{copyNotice}</Text>}
```

with the style, added beside `error`:

```ts
  notice: { fontSize: 12, fontWeight: '700', color: '#111111', marginBottom: 12 },
```

Make the phone list row open the editor — wrap the existing row contents:

```tsx
              <Pressable key={member.id} onPress={() => setEditing({ date: selectedDay, shift: memberShifts[0] ?? null })} style={styles.listRow}>
                <Text style={styles.memberName}>{member.fullName ?? 'Staff member'}</Text>
                <Text style={memberShifts.length === 0 ? styles.off : styles.times}>
                  {memberShifts.length === 0 ? 'Off' : memberShifts.map((s) => `${s.start}–${s.end}`).join(', ')}
                </Text>
              </Pressable>
```

and the grid cell likewise — replace the day `<Text>` inside the member row with:

```tsx
                  return (
                    <Pressable key={date} onPress={() => setEditing({ date, shift: cell[0] ?? null })}>
                      <Text style={[styles.gridCell, cell.length === 0 && styles.off]}>
                        {cell.length === 0 ? '—' : cell.map((s) => `${s.start}–${s.end}`).join('\n')}
                      </Text>
                    </Pressable>
                  );
```

Tapping a cell that already holds more than one shift opens the first; a second shift on the same day is reached by adding one and editing it. That is a deliberate simplification of a rare case rather than an oversight — the alternative is a per-cell picker for a situation the editor's overlap rule already makes uncommon.

Finally render the modal at the end of the component:

```tsx
      {editing && (
        <ShiftEditorModal
          visible
          date={editing.date}
          members={members}
          existing={editing.shift}
          context={{
            hours: shop?.openingHours ?? {},
            onLeave: onLeaveMemberIds(timeOff, fromDateColumn(editing.date)),
            sameDayShifts: shifts.filter((shift) => shift.date === editing.date),
          }}
          onClose={() => setEditing(null)}
          onSave={saveShift}
          onDelete={removeShift}
        />
      )}
```

Note `onLeaveMemberIds` takes the date to check, so it is called per-edit with the shift's own date rather than today's.

- [ ] **Step 3: Verify**

Run: `npx jest && npx tsc --noEmit && npx expo lint`
Expected: `Test Suites: 16 passed`, `Tests: 346 passed` (unchanged); no TypeScript output; lint at **43** problems, the same count as after Task 4 — this task adds no new effect.

- [ ] **Step 4: Commit**

```bash
git add src/components/schedule/shift-editor-modal.tsx src/components/schedule/schedule-tab.tsx
git commit -m "feat: add the shift editor and copy last week

The editor is deliberately thin -- every rule it shows comes from
validateShift, which is unit-tested. Only an overlap disables Save;
outside-hours and on-leave render as warnings.

Copy last week reports both counts. An owner who asked to copy a week
needs to know which shifts didn't make it, rather than the operation
silently doing part of the job or refusing over one clash."
```

---

### Task 6: My shifts on `/me`

**Files:**
- Modify: `src/components/staff-self-service.tsx`

**Interfaces:**
- Consumes: `listMyShifts` from `@/lib/shifts` (Task 3); `Shift` from `@/lib/scheduling` (Task 1).
- Produces: nothing. This is the last task.

- [ ] **Step 1: Load and render upcoming shifts**

In `src/components/staff-self-service.tsx`, add the imports:

```tsx
import { toDateColumn } from '@/lib/period';
import type { Shift } from '@/lib/scheduling';
import { listMyShifts } from '@/lib/shifts';
```

Add state beside the existing `entries` / `requests` state (around line 19-20):

```tsx
  const [shifts, setShifts] = useState<Shift[]>([]);
```

The component already loads its data through one `Promise.all` (around line 34-39) that fetches time entries and time-off requests together. Add the shifts call as a third element of that same `Promise.all` and set it alongside the existing `setEntries` — one round trip rather than a second sequential fetch:

```tsx
        listMyShifts(member.id, toDateColumn(new Date())),
```

```tsx
      setShifts(myShifts);
```

destructuring the third result in the same statement that already destructures the other two.

Render a section after the existing "RECENT SHIFTS" block:

```tsx
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>MY UPCOMING SHIFTS</Text>
        {shifts.length === 0 ? (
          <Text style={styles.empty}>Nothing scheduled yet.</Text>
        ) : (
          shifts.slice(0, 10).map((shift) => (
            <View key={shift.id} style={styles.row}>
              <Text style={styles.rowText}>
                {shift.date}
                {shift.note ? ` · ${shift.note}` : ''}
              </Text>
              <Text style={styles.duration}>{shift.start}–{shift.end}</Text>
            </View>
          ))
        )}
      </View>
```

This reuses the file's existing `section`, `sectionTitle`, `empty`, `row`, `rowText` and `duration` styles — all already defined there — so no new style is needed. The layout matches the RECENT SHIFTS block directly above it: descriptive text on the left, the time in bold on the right.

This path goes through the `read own shifts` RLS policy, so it works for a cashier with no schedule permission — which is the point of that policy.

- [ ] **Step 2: Verify**

Run: `npx jest && npx tsc --noEmit && npx expo lint`
Expected: `Test Suites: 16 passed`, `Tests: 346 passed`; no TypeScript output; lint at **43** problems.

- [ ] **Step 3: Commit**

```bash
git add src/components/staff-self-service.tsx
git commit -m "feat: show a member their own upcoming shifts

Goes through the 'read own shifts' RLS policy, so a cashier with no
schedule permission still sees their own rota -- which is what that
policy exists for."
```

---

## Done when

- `npx jest` reports 16 suites / 346 tests passing.
- `npx tsc --noEmit` is clean; `npx expo lint` reports 43 problems (one more than the previous 42 baseline, from the Schedule tab's `reload` effect — the same pattern every other tab uses).
- `supabase db reset` applies the whole chain from scratch.
- A manager can create a shift, see it in the week grid, edit it, delete it, and copy last week.
- Scheduling someone outside opening hours or on approved leave warns but saves; an overlapping shift disables Save.
- A cashier with no schedule permission sees no Schedule tab, but sees their own shifts on `/me`.

## Deliberately not done here

- **Recurring shifts.** Replaced by copy-last-week; a pattern model can be added later without changing the shift table.
- **Draft versus published rotas, shift swaps, coverage warnings.** Each is its own feature.
- **Planned versus actual** against `time_entries`, and **labour cost forecast** from scheduled hours × pay rates. Both are now cheap and both deserve their own decision.
- **Notifications.** `docs/backlog/2026-08-01-notification-delivery.md` is unbuilt, so nothing can tell anyone about a shift.
- **`supabase db push`.** Local verification only.
