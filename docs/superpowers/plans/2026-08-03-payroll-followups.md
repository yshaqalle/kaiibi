# Payroll Follow-ups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close three independent defects left open by the pay-cadence work — an invisible cadence filter, a staff CSV that no longer round-trips pay, and a concurrent-post race that can pay someone twice.

**Architecture:** Three unrelated fixes. The draft card loads the roster when it opens and reports how many staff the chosen cadence covers. A new pure helper maps CSV pay columns to a pay patch, and the import applies it after provisioning. `post_payroll_run` takes a shop-scoped advisory lock so posts serialise within a shop.

**Tech Stack:** Expo SDK 57, React Native 0.86, React 19.2, TypeScript 6.0, Jest 29 (`jest-expo`, TZ pinned to `America/New_York`), Supabase/Postgres 17.

**Spec:** `docs/superpowers/specs/2026-08-03-payroll-followups-design.md`

## Global Constraints

- **Expo SDK 57.** Per `AGENTS.md`, consult https://docs.expo.dev/versions/v57.0.0/ before writing framework code. Only Task 1 touches UI, using primitives already imported in that file.
- **Money is integer cents.** `toCents` already parses the exported `"$3,000.00"` to `300000` — do not add a second parser.
- **A salaried `pay_rate_cents` is per month.** `Pay Rate Unit` in the CSV is informational: validate it against the pay type, never convert with it.
- **`pay_cadence` is `not null`.** No write path may send `null`; absent means `'monthly'`.
- **`npx jest`** baseline **13 suites / 269 tests**. `jest.config.js` pins `process.env.TZ = 'America/New_York'` deliberately — do not remove it; a date bug that only appears outside UTC was shipped once already.
- **`npx tsc --noEmit`** clean; **`npx expo lint`** has **42 known pre-existing problems (38 errors, 4 warnings)** and must gain none. Several are `react-hooks/set-state-in-effect` — avoid adding a `useEffect` that sets state, or you will add a 43rd.
- **Database work is local only.** Stack is running; `DB_URL` is `postgresql://postgres:postgres@127.0.0.1:54322/postgres`. **Never run `supabase db push`** — the remote is production and is currently in sync.
- **Database verification:** `supabase db reset && psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -f supabase/tests/verify-accounting-writes.sql`, ending `################  ALL CHECKS PASSED  ################` and `Rolled back — no rows left behind.`

---

### Task 1: Show how many staff a cadence covers

**Files:**
- Modify: `src/components/accounting/payroll-tab.tsx` — imports, component state, the `onNew` handler, the create card, styles

**Interfaces:**
- Consumes: `listStaff` from `@/lib/staff`; `StaffMember.payCadence` and `PayCadence` (already imported in this file).
- Produces: nothing. Independent of Tasks 2 and 3.

No automated coverage is possible — there is no React Native testing library in `devDependencies`. Verified by typecheck, lint, and reading.

- [ ] **Step 1: Extract the cadence labels**

The chips build their labels inline with a nested ternary. The new sentence needs the same words, so lift them into one record. Add above the component:

```tsx
// Shared by the chips and the coverage line so the prose can never say
// "biweekly" while the chip says "Every 2 weeks".
const CADENCE_LABELS: Record<PayCadence, string> = {
  weekly: 'Weekly',
  biweekly: 'Every 2 weeks',
  semimonthly: 'Twice a month',
  monthly: 'Monthly',
};
```

Replace the chip's inline label expression (currently `option === 'biweekly' ? 'Every 2 weeks' : option === 'semimonthly' ? 'Twice a month' : option[0].toUpperCase() + option.slice(1)`) with `CADENCE_LABELS[option]`.

- [ ] **Step 2: Load the roster when the card opens**

Add state beside the existing `creating` state:

```tsx
  // Loaded when the create card opens so the covered count can be shown before
  // a run exists. Null means "not loaded yet" -- distinct from an empty roster.
  const [activeStaff, setActiveStaff] = useState<StaffMember[] | null>(null);
```

Add `StaffMember` to the `@/types/models` type import at the top of the file.

Add the handler beside `startRun`:

```tsx
  // Deliberately not a useEffect keyed on `creating`: this file already carries
  // a react-hooks/set-state-in-effect finding, and adding another effect that
  // sets state would add a second.
  const openCreate = async () => {
    setCreating(true);
    setActiveStaff(null);
    if (!shop) return;
    try {
      const members = await listStaff(shop.id);
      setActiveStaff(members.filter((member) => member.active));
    } catch {
      // A failed load leaves the count hidden rather than blocking the card --
      // startRun re-fetches and will surface a real error there.
      setActiveStaff(null);
    }
  };
```

Change the header action to use it:

```tsx
      <PayrollHeaderActions allowed={allowed} creating={creating} onNew={openCreate} setHeaderActions={setHeaderActions} />
```

- [ ] **Step 3: Derive the count**

Add after the existing `periodOptions` derivation:

```tsx
  // How many of the active roster this run will actually include. The draft
  // silently drops members on a different cadence, so without this a shop that
  // moves to weekly and misses one member excludes them from every run.
  const coveredCount =
    activeStaff === null ? null : cadence === null ? activeStaff.length : activeStaff.filter((member) => member.payCadence === cadence).length;
```

- [ ] **Step 4: Render the line and gate Build draft**

In the create card, insert immediately after the closing `</View>` of the cadence chip row and before the `periodOptions.reason` block:

```tsx
          {activeStaff !== null && coveredCount !== null && (
            <Text style={coveredCount === 0 ? styles.coverageEmpty : styles.coverage}>
              {cadence === null
                ? `This run covers all ${activeStaff.length} active staff.`
                : coveredCount === 0
                  ? `No active staff are on the ${CADENCE_LABELS[cadence].toLowerCase()} cadence. Set one in People, or pick a different period.`
                  : `This ${CADENCE_LABELS[cadence].toLowerCase()} run covers ${coveredCount} of ${activeStaff.length} active staff.`}
            </Text>
          )}
```

Change the Build draft button so a cadence covering nobody cannot create a run. This also prevents the empty draft that currently gets created and then fails to post with `this pay run has nothing to pay`:

```tsx
            <Pressable
              onPress={startRun}
              disabled={busy || coveredCount === 0}
              style={[styles.primaryButton, (busy || coveredCount === 0) && styles.buttonDisabled]}
            >
              <Text style={styles.primaryButtonText}>{busy ? 'Working…' : 'Build draft'}</Text>
            </Pressable>
```

Note `coveredCount === 0` is false when `coveredCount` is `null`, so a roster that has not loaded (or failed to load) leaves the button enabled — `startRun` re-fetches and reports its own errors.

- [ ] **Step 5: Add the two styles**

In the `StyleSheet.create` block, after the existing `createTitle` entry:

```ts
  coverage: { fontSize: 11.5, color: '#999999', lineHeight: 16, marginBottom: 10 },
  coverageEmpty: { fontSize: 11.5, fontWeight: '700', color: '#C0392B', lineHeight: 16, marginBottom: 10 },
```

`#C0392B` is the danger colour already used by `styles.error` and `styles.dangerText` in this codebase.

- [ ] **Step 6: Verify**

Run: `npx jest && npx tsc --noEmit && npx expo lint`
Expected: `Test Suites: 13 passed`, `Tests: 269 passed` (unchanged — this task adds no tests); no TypeScript output; lint at exactly 42 problems.

If lint reports 43, you added an effect that sets state — go back to Step 2 and use the handler form.

- [ ] **Step 7: Commit**

```bash
git add "src/components/accounting/payroll-tab.tsx"
git commit -m "feat: show how many staff a pay run's cadence covers

The draft silently drops members on a different cadence and nothing said
so -- cadence isn't on the roster, the card showed only chips, the run
list shows a bare 'N people'. Since pay_cadence backfilled to monthly on
every existing row, a shop moving to weekly that missed one member would
have excluded them from every run indefinitely.

Disabling Build draft at zero also stops the empty draft that currently
gets created and then fails to post with 'nothing to pay'."
```

---

### Task 2: Round-trip pay through the staff CSV

**Files:**
- Modify: `src/lib/staff-import.ts` — new exported helper, new import behaviour
- Create: `src/lib/__tests__/staff-import.test.ts`
- Modify: `src/app/(admin)/(tabs)/people.tsx:62-69` (export columns), `:482` (import call)

**Interfaces:**
- Consumes: `toCents` from `@/lib/currency`; `isValidRateInput`, `payRateUnitLabel` from `@/lib/pay-rate`; `PayCadence` from `@/lib/pay-periods`; `updateStaffPay` from `@/lib/staff`.
- Produces:
  ```ts
  type StaffPayColumns =
    | { kind: 'none' }
    | { kind: 'ok'; patch: { payType: StaffMember['payType']; payRateCents: number | null; payCadence: PayCadence } }
    | { kind: 'error'; reason: string }
  parseStaffPayColumns(raw: Record<string, string>): StaffPayColumns
  runStaffImport(shopId: string, roles: Role[], parsed: ParsedCsv, canManagePayroll: boolean): Promise<ImportReport<StaffMember>>
  ```

- [ ] **Step 1: Write the failing tests**

Create `src/lib/__tests__/staff-import.test.ts`:

```ts
import { parseStaffPayColumns } from '@/lib/staff-import';

describe('parseStaffPayColumns', () => {
  it('reports nothing to do when no pay columns are present', () => {
    expect(parseStaffPayColumns({ 'Full Name': 'Hodan Ali' })).toEqual({ kind: 'none' });
  });

  it('treats blank pay columns as nothing to do', () => {
    expect(parseStaffPayColumns({ 'Pay Type': '  ', 'Pay Rate': '', 'Pay Cadence': '' })).toEqual({ kind: 'none' });
  });

  // The export writes formatAccountingCents, so this is the literal string a
  // round-trip produces. toCents strips everything but digits and '.'.
  it('parses the exact string the export writes', () => {
    expect(parseStaffPayColumns({ 'Pay Type': 'salary', 'Pay Rate': '$3,000.00', 'Pay Rate Unit': 'per month' })).toEqual({
      kind: 'ok',
      patch: { payType: 'salary', payRateCents: 300000, payCadence: 'monthly' },
    });
  });

  it('reads the cadence when present', () => {
    expect(parseStaffPayColumns({ 'Pay Type': 'hourly', 'Pay Rate': '$8.50', 'Pay Cadence': 'biweekly' })).toEqual({
      kind: 'ok',
      patch: { payType: 'hourly', payRateCents: 850, payCadence: 'biweekly' },
    });
  });

  // pay_cadence is NOT NULL in the database, so an absent value must resolve to
  // the schema default rather than to null.
  it('defaults a missing cadence to monthly', () => {
    const result = parseStaffPayColumns({ 'Pay Type': 'hourly', 'Pay Rate': '8.50' });
    expect(result).toEqual({ kind: 'ok', patch: { payType: 'hourly', payRateCents: 850, payCadence: 'monthly' } });
  });

  it('is case-insensitive about pay type and cadence', () => {
    expect(parseStaffPayColumns({ 'Pay Type': 'Salary', 'Pay Cadence': 'Monthly', 'Pay Rate': '3000' })).toEqual({
      kind: 'ok',
      patch: { payType: 'salary', payRateCents: 300000, payCadence: 'monthly' },
    });
  });

  it('allows a pay type with no rate yet', () => {
    expect(parseStaffPayColumns({ 'Pay Type': 'hourly' })).toEqual({
      kind: 'ok',
      patch: { payType: 'hourly', payRateCents: null, payCadence: 'monthly' },
    });
  });

  it('rejects an unknown pay type', () => {
    const result = parseStaffPayColumns({ 'Pay Type': 'contractor', 'Pay Rate': '10' });
    expect(result).toMatchObject({ kind: 'error' });
    expect((result as { reason: string }).reason).toMatch(/Pay Type/);
  });

  it('rejects an unknown cadence', () => {
    const result = parseStaffPayColumns({ 'Pay Type': 'hourly', 'Pay Rate': '10', 'Pay Cadence': 'fortnightly' });
    expect(result).toMatchObject({ kind: 'error' });
    expect((result as { reason: string }).reason).toMatch(/Pay Cadence/);
  });

  it('rejects an unparseable rate rather than silently storing zero', () => {
    const result = parseStaffPayColumns({ 'Pay Type': 'hourly', 'Pay Rate': 'ten dollars' });
    expect(result).toMatchObject({ kind: 'error' });
    expect((result as { reason: string }).reason).toMatch(/Pay Rate/);
  });

  it('rejects a rate given without a pay type, which would have no unit', () => {
    const result = parseStaffPayColumns({ 'Pay Rate': '3000' });
    expect(result).toMatchObject({ kind: 'error' });
  });

  // The unit is informational and never converts. A file claiming "per hour"
  // beside a salary is self-contradictory, and guessing which half is right
  // would silently misstate someone's pay.
  it('rejects a unit that contradicts the pay type', () => {
    const result = parseStaffPayColumns({ 'Pay Type': 'salary', 'Pay Rate': '3000', 'Pay Rate Unit': 'per hour' });
    expect(result).toMatchObject({ kind: 'error' });
    expect((result as { reason: string }).reason).toMatch(/Pay Rate Unit/);
  });

  it('accepts a matching unit', () => {
    expect(parseStaffPayColumns({ 'Pay Type': 'hourly', 'Pay Rate': '8.50', 'Pay Rate Unit': 'per hour' })).toMatchObject({
      kind: 'ok',
    });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest src/lib/__tests__/staff-import.test.ts`
Expected: FAIL — `parseStaffPayColumns` is not exported from `@/lib/staff-import`.

- [ ] **Step 3: Write the helper**

In `src/lib/staff-import.ts`, add to the imports:

```ts
import { toCents } from '@/lib/currency';
import type { PayCadence } from '@/lib/pay-periods';
import { isValidRateInput, payRateUnitLabel } from '@/lib/pay-rate';
import { provisionStaff, updateStaffPay } from '@/lib/staff';
```

(the existing `provisionStaff` import becomes the combined line above)

Add the helper:

```ts
const PAY_TYPES = ['hourly', 'salary', 'fixed'] as const;
const CADENCES = ['weekly', 'biweekly', 'semimonthly', 'monthly'] as const;

export type StaffPayColumns =
  | { kind: 'none' }
  | { kind: 'ok'; patch: { payType: StaffMember['payType']; payRateCents: number | null; payCadence: PayCadence } }
  | { kind: 'error'; reason: string };

// Maps the pay columns of one CSV row to a pay patch, or to a reason the row
// can't be accepted. Pure, so the logic worth defending is testable without
// stubbing the provisioning Edge Function.
//
// `Pay Rate Unit` is informational and never converts: a salaried rate is
// canonically per month (see pay-rate.ts), which is exactly what the export
// writes. It IS validated, because a file claiming "per hour" beside a salary
// is self-contradictory and guessing which half is right would misstate pay.
export function parseStaffPayColumns(raw: Record<string, string>): StaffPayColumns {
  const payTypeRaw = raw['Pay Type']?.trim().toLowerCase() ?? '';
  const rateRaw = raw['Pay Rate']?.trim() ?? '';
  const cadenceRaw = raw['Pay Cadence']?.trim().toLowerCase() ?? '';
  const unitRaw = raw['Pay Rate Unit']?.trim().toLowerCase() ?? '';

  if (!payTypeRaw && !rateRaw && !cadenceRaw) return { kind: 'none' };

  if (!payTypeRaw) {
    return { kind: 'error', reason: 'Pay Rate or Pay Cadence given without a Pay Type — add one of hourly, salary or fixed.' };
  }
  const payType = PAY_TYPES.find((type) => type === payTypeRaw);
  if (!payType) {
    return { kind: 'error', reason: `Pay Type "${raw['Pay Type']?.trim()}" is not one of hourly, salary or fixed.` };
  }

  let payRateCents: number | null = null;
  if (rateRaw) {
    if (!isValidRateInput(rateRaw.replace(/[$,]/g, ''))) {
      return { kind: 'error', reason: `Pay Rate "${rateRaw}" is not a number.` };
    }
    payRateCents = toCents(rateRaw);
  }

  let payCadence: PayCadence = 'monthly';
  if (cadenceRaw) {
    const found = CADENCES.find((cadence) => cadence === cadenceRaw);
    if (!found) {
      return {
        kind: 'error',
        reason: `Pay Cadence "${raw['Pay Cadence']?.trim()}" is not one of weekly, biweekly, semimonthly or monthly.`,
      };
    }
    payCadence = found;
  }

  if (unitRaw && unitRaw !== payRateUnitLabel(payType)) {
    return {
      kind: 'error',
      reason: `Pay Rate Unit "${raw['Pay Rate Unit']?.trim()}" doesn't match Pay Type "${payType}" (expected "${payRateUnitLabel(payType)}").`,
    };
  }

  return { kind: 'ok', patch: { payType, payRateCents, payCadence } };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest src/lib/__tests__/staff-import.test.ts`
Expected: PASS, 13 tests.

- [ ] **Step 5: Apply the patch during import**

Change `runStaffImport`'s signature to take the permission flag:

```ts
export async function runStaffImport(
  shopId: string,
  roles: Role[],
  parsed: ParsedCsv,
  canManagePayroll: boolean
): Promise<ImportReport<StaffMember>> {
```

Inside the row loop, after the role lookup and before the `try`, parse the pay columns. Without the permission the columns are ignored rather than rejected — someone who cannot see pay should still be able to import names and roles:

```ts
    const pay = canManagePayroll ? parseStaffPayColumns(raw) : ({ kind: 'none' } as const);
    if (pay.kind === 'error') {
      reject(pay.reason);
      continue;
    }
```

Replace the `accepted.push({...})` block's pay fields and add the follow-up write. The full `try` becomes:

```ts
    try {
      const created = await provisionStaff({ shopId, fullName, email, password: raw['Password']?.trim() || undefined, roleId: role.id });

      if (pay.kind === 'ok') {
        try {
          await updateStaffPay(created.member.id, pay.patch);
        } catch (err) {
          // The member EXISTS at this point. Reporting them accepted would hide
          // a roster with no pay set; reporting a plain rejection would imply
          // nothing was created and invite a re-import that fails on duplicate
          // email. So the reason says exactly what happened.
          reject(
            `Staff member was created, but their pay could not be set (${err instanceof Error ? err.message : 'unknown error'}). Set it in People.`
          );
          continue;
        }
      }

      accepted.push({
        id: created.member.id,
        shopId,
        userId: created.userId,
        roleId: role.id,
        roleName: role.name,
        active: true,
        fullName,
        email: created.email,
        createdAt: new Date().toISOString(),
        hireDate: null,
        payType: pay.kind === 'ok' ? pay.patch.payType : null,
        payRateCents: pay.kind === 'ok' ? pay.patch.payRateCents : null,
        payCadence: pay.kind === 'ok' ? pay.patch.payCadence : 'monthly',
      });
    } catch (err) {
      reject(err instanceof Error ? err.message : 'Could not add this staff member.');
    }
```

- [ ] **Step 6: Export the cadence, and pass the permission flag**

In `src/app/(admin)/(tabs)/people.tsx`, add to `TEAM_EXPORT_COLUMNS_WITH_PAY` after the `Pay Rate Unit` entry:

```tsx
  { header: 'Pay Cadence', value: (m) => m.payCadence },
```

Change the import call at line ~482:

```tsx
          run: (parsed) => runStaffImport(shop.id, roles, parsed, canManagePayroll),
```

`canManagePayroll` is already in scope at line 422.

- [ ] **Step 7: Verify**

Run: `npx jest && npx tsc --noEmit && npx expo lint`
Expected: `Test Suites: 14 passed` (13 + the new file), `Tests: 282 passed` (269 + 13); no TypeScript output; lint at 42 problems.

- [ ] **Step 8: Commit**

```bash
git add src/lib/staff-import.ts src/lib/__tests__/staff-import.test.ts "src/app/(admin)/(tabs)/people.tsx"
git commit -m "feat: round-trip pay through the staff CSV

Export emitted pay but import hard-nulled it, so exporting a roster and
re-importing it silently dropped every pay field. Export also lacked Pay
Cadence.

toCents already parses the exported '\$3,000.00' unchanged, so no export
format change was needed. Pay Rate Unit is validated, never used to
convert -- a salaried rate is canonically per month, which is what the
export writes.

A member whose provisioning succeeds but whose pay write fails is
reported with a reason saying they were created and only their pay needs
setting, so nobody re-imports them into a duplicate-email error."
```

---

### Task 3: Serialise pay-run posts within a shop

**Files:**
- Create: `supabase/migrations/20260804040000_payroll_post_advisory_lock.sql`

**Interfaces:**
- Consumes: the current `post_payroll_run` definition in `supabase/migrations/20260804030100_payroll_per_member_overlap.sql`.
- Produces: `post_payroll_run(uuid)` unchanged in signature and in every guard; posts now serialise per shop.

**Why this task is written as a copy-plus-one-line rather than as full source:** the function is ~90 lines containing five guards and an expense insert whose exact columns and dating the P&L depends on. Re-typing it invites a subtle transcription change that reads as intentional. Copy the existing definition byte-for-byte and add exactly what is specified. Step 4 diffs the two to prove nothing else moved.

- [ ] **Step 1: Create the migration by copying the current definition**

Create `supabase/migrations/20260804040000_payroll_post_advisory_lock.sql`.

Copy the entire `create or replace function public.post_payroll_run(uuid) ... $$;` block from `supabase/migrations/20260804030100_payroll_per_member_overlap.sql` **byte-for-byte**, along with its trailing `grant execute on function public.post_payroll_run(uuid) to authenticated;`.

Then make exactly two changes, described in Steps 2 and 3.

- [ ] **Step 2: Add the lock**

Add `v_lock_shop uuid;` to the `declare` block, alongside the existing declarations.

Then, immediately after `begin` and **before** the existing `select * into v_run from public.payroll_runs where id = p_run_id for update;`, insert:

```sql
  -- Serialises posting within a shop. The row lock below covers only THIS run,
  -- so two different overlapping runs sharing a member each locked a different
  -- row, neither saw the other's uncommitted 'posted' status, and both
  -- succeeded -- paying that member twice. Harmless while the old shop-wide
  -- guard rejected overlapping runs outright; per-member cadence makes
  -- overlapping drafts the normal mode, so the race became reachable.
  --
  -- The shop id is read separately because v_run isn't populated until the
  -- statement below, so the lock key can't be derived from it yet. Transaction-
  -- scoped, so it releases on commit or rollback with nothing to unlock
  -- explicitly. Keyed on the shop, so posts in different shops never block each
  -- other. Taken BEFORE the row lock so every guard below reads committed state
  -- rather than racing a concurrent post.
  select shop_id into v_lock_shop from public.payroll_runs where id = p_run_id;
  if v_lock_shop is null then
    raise exception 'pay run % not found', p_run_id;
  end if;
  perform pg_advisory_xact_lock(hashtext('payroll_post:' || v_lock_shop::text));
```

The existing not-found guard further down stays exactly as it is. The check above exists only so the lock key is never computed from a null, and it raises the identical message, so no caller can tell which one fired.

- [ ] **Step 3: Update the function comment**

The existing `comment on function public.post_payroll_run(uuid) is '...'` documents this race as a known limitation. Rewrite that portion so it records the race as closed and says how, keeping the rest of the comment's content — the rejects list, and the note that the expense is dated `period_end`.

- [ ] **Step 4: Prove nothing else changed**

Extract both function bodies and diff them:

```bash
sed -n '/^create or replace function public.post_payroll_run/,/^\$\$;/p' supabase/migrations/20260804030100_payroll_per_member_overlap.sql > /tmp/old-fn.sql
sed -n '/^create or replace function public.post_payroll_run/,/^\$\$;/p' supabase/migrations/20260804040000_payroll_post_advisory_lock.sql > /tmp/new-fn.sql
diff -u /tmp/old-fn.sql /tmp/new-fn.sql
```

Expected: the ONLY additions are the `v_lock_shop uuid;` declaration and the lock block from Step 2 — no deletions at all, and no other line reordered. If the diff shows anything else — a reflowed guard, a changed message, a moved expense column — you introduced it; go back and re-copy from the source file rather than patching what you have.

Paste the diff into your report.

- [ ] **Step 5: Apply locally and run the database tests**

Run:
```bash
supabase db reset && psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -f supabase/tests/verify-accounting-writes.sql
```
Expected: ends `################  ALL CHECKS PASSED  ################` and `Rolled back — no rows left behind.`

This proves the lock breaks none of the single-session paths. It does **not** prove the race is closed — that needs two sessions, which this harness cannot do (it runs as one `DO` block). Do not add a test claiming otherwise.

- [ ] **Step 6: Manually verify the lock actually serialises**

Open two `psql` sessions against the local database and confirm the second blocks:

```bash
# Session 1
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -c \
  "begin; select pg_advisory_xact_lock(hashtext('payroll_post:00000000-0000-0000-0000-000000000001')); select pg_sleep(5); commit;" &
# Session 2, immediately after
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -c \
  "\timing on
   begin; select pg_advisory_xact_lock(hashtext('payroll_post:00000000-0000-0000-0000-000000000001')); commit;"
```

Expected: session 2's `pg_advisory_xact_lock` reports a duration of roughly 5 seconds, proving it waited. Repeat with a different shop uuid in session 2 and confirm it returns immediately, proving shops do not block each other. Report both timings.

- [ ] **Step 7: Confirm the JS suite is untouched**

Run: `npx jest && npx tsc --noEmit`
Expected: `Test Suites: 14 passed`, `Tests: 282 passed`; no TypeScript output. This task changes no TypeScript.

- [ ] **Step 8: Commit**

```bash
git add supabase/migrations/20260804040000_payroll_post_advisory_lock.sql
git commit -m "fix: serialise pay-run posts within a shop

post_payroll_run locked only its own row, so two different overlapping
runs sharing a member each locked a different row, neither saw the
other's uncommitted 'posted' status, and both succeeded -- paying that
member twice.

The race is pre-existing but was unreachable while the old shop-wide
guard rejected overlapping runs outright. Per-member cadence makes
overlapping drafts the normal mode, so it became routinely reachable.

A shop-scoped transaction advisory lock, taken before the row lock so
every guard reads committed state. No automated test defends this -- the
DB harness is single-session and a race needs two -- so it was verified
by hand with two psql sessions."
```

---

## Done when

- `npx jest` reports 14 suites / 282 tests passing.
- `npx tsc --noEmit` and `npx expo lint` are clean (lint at its 42-problem baseline).
- `supabase db reset && psql "$DB_URL" -f supabase/tests/verify-accounting-writes.sql` ends with `ALL CHECKS PASSED`.
- Opening the pay-run create card shows how many active staff the chosen cadence covers, and Build draft is disabled when that is zero.
- Exporting the team CSV and re-importing it preserves pay type, rate and cadence.
- Two `psql` sessions confirm the advisory lock serialises within a shop and not across shops.

## Deliberately not done here

- **Showing cadence on the People roster.** A later addition; the draft card closes the reported problem.
- **Adding the pay columns to the downloadable CSV template** (`STAFF_TEMPLATE_COLUMNS` / `STAFF_EXAMPLE_ROW`). The spec scopes this to export and import; a template that advertises columns a non-payroll user's import will ignore is its own small design question.
- **Making the staff import an upsert.** It provisions new members only, and a duplicate email already rejects.
- **Changing the CSV money format** to a raw number. It parses back correctly as-is.
- **A warnings channel on `ImportReport`.** Shared with customers and products; one case does not justify it.
- **`supabase db push`.** The remote is currently in sync; applying this migration is a separate, deliberate act.
