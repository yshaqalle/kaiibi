# Payroll Draft Warnings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist and display the payroll draft warnings that `computePayrollDraft` already computes and currently throws away, and block posting a line that warns of no pay rate and has no amount.

**Architecture:** Two frozen columns on `payroll_run_lines` carry the warning and its severity, written at draft time and never recomputed. `post_payroll_run` gains a guard that tests `warning_blocking AND amount_cents = 0`, so typing an amount clears the block while the warning survives as history. The run editor renders warnings under each line and disables Post while a blocked line remains.

**Tech Stack:** Expo SDK 57, React Native 0.86, React 19.2, TypeScript 6.0, Jest 29 (`jest-expo`), Supabase/Postgres 17.

**Spec:** `docs/superpowers/specs/2026-08-03-payroll-draft-warnings-design.md`

## Global Constraints

- **Expo SDK 57.** Per `AGENTS.md`, consult https://docs.expo.dev/versions/v57.0.0/ before writing framework code. This plan touches no Expo APIs.
- **Warnings are frozen, never recomputed.** Written once at draft time, exactly like the existing `pay_type` / `pay_rate_cents` columns. Recomputing at display time would let a later pay-rate change alter what a past run appears to have warned about.
- **The block tests `amount_cents = 0`, not the presence of a warning.** Entering an amount must clear the block. Never mutate or clear the stored warning to unblock — the line keeps it as audit history.
- **Only `No pay rate set` is blocking.** The clocked-in and prorated warnings are advisory and must never block a post.
- **Money is integer cents**; the existing `hourly` / `salary` / `fixed` amounts must not change. This plan changes no amount arithmetic.
- **JS test command is `npx jest`.** Baseline before this work: **12 suites / 231 tests passing**.
- **`npx tsc --noEmit`** clean; **`npx expo lint`** has **42 known pre-existing problems (38 errors, 4 warnings)** and must gain none.
- **Database tests are real and required** (Tasks 2 and 3). The local stack is already running; `supabase status` prints `DB_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres`. If it is not running, `supabase start` first.
- **Never run `supabase db push`** in this plan. That targets the remote project. Local verification only, via `supabase db reset`.

---

### Task 1: Warning severity in the pure module

Pure arithmetic first, with real Jest coverage. Nothing is persisted or displayed yet.

**Files:**
- Modify: `src/lib/payroll-reporting.ts:9-19` (`PayrollDraftLine`), `:56-93` (the branches)
- Test: `src/lib/__tests__/payroll-reporting.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces, relied on by Tasks 2–4:
  ```ts
  // PayrollDraftLine gains (it already has `warning: string | null`):
  warningBlocking: boolean
  ```

This task deliberately does **not** touch `PayrollRunLine` in `src/types/models.ts`. Adding required fields there without updating `mapLineRow` in the same commit would leave `npx tsc --noEmit` failing at the end of this task. Both changes land together in Task 2.

- [ ] **Step 1: Write the failing tests**

Append these to the existing `describe('computePayrollDraft', ...)` block in `src/lib/__tests__/payroll-reporting.test.ts`:

```ts
  // A missing pay rate produces a zero amount -- a real person paid nothing.
  // That is a different kind of problem from an approximate figure, and is the
  // only warning allowed to block a post.
  it('marks a missing pay rate as blocking', () => {
    const lines = computePayrollDraft([makeMember({ payRateCents: null, payType: null })], [], '2026-08-01', '2026-08-07');
    expect(lines[0].warning).toMatch(/No pay rate/);
    expect(lines[0].warningBlocking).toBe(true);
  });

  it('leaves an open-shift warning advisory', () => {
    const lines = computePayrollDraft(
      [makeMember({ payType: 'hourly', payRateCents: 500 })],
      [{ ...makeEntry('2026-08-03', 0), clockOut: null }],
      '2026-08-01',
      '2026-08-07'
    );
    expect(lines[0].warning).toMatch(/still clocked in/);
    expect(lines[0].warningBlocking).toBe(false);
  });

  it('leaves a proration warning advisory', () => {
    const lines = computePayrollDraft(
      [makeMember({ payType: 'salary', payRateCents: 300000 })],
      [],
      '2026-08-01',
      '2026-08-07'
    );
    expect(lines[0].warning).toMatch(/Prorated/);
    expect(lines[0].warningBlocking).toBe(false);
  });

  it('is not blocking when there is nothing to warn about', () => {
    const lines = computePayrollDraft(
      [makeMember({ payType: 'salary', payRateCents: 300000 })],
      [],
      '2026-08-01',
      '2026-08-31'
    );
    expect(lines[0].warning).toBeNull();
    expect(lines[0].warningBlocking).toBe(false);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest src/lib/__tests__/payroll-reporting.test.ts`
Expected: FAIL — `warningBlocking` is `undefined`, so each `toBe(true)` / `toBe(false)` fails. TypeScript will also flag the property as missing.

- [ ] **Step 3: Add the field to the draft type**

In `src/lib/payroll-reporting.ts`, add to `PayrollDraftLine` immediately after the existing `warning` field:

```ts
  // Only a warning that means the money is *wrong* -- currently just a missing
  // pay rate, which pays zero -- blocks a post. An approximate figure is
  // displayed and left to the owner's judgement.
  warningBlocking: boolean;
```

- [ ] **Step 4: Set the severity on every branch**

In `src/lib/payroll-reporting.ts`, every `return` inside `computePayrollDraft`'s `.map()` needs the new field. Make these five edits:

```ts
      if (member.payRateCents === null || member.payType === null) {
        return {
          ...base,
          amountCents: 0,
          warning: 'No pay rate set — add one in People, or enter the amount here.',
          warningBlocking: true,
        };
      }
```

```ts
        return { ...base, amountCents, warning, warningBlocking: false };
```
(the `hourly` branch)

```ts
      if (member.payType === 'fixed') {
        return { ...base, amountCents: member.payRateCents, warning: null, warningBlocking: false };
      }
```

```ts
      if (isWholeCalendarMonth(periodStart, periodEnd)) {
        return { ...base, amountCents: member.payRateCents, warning: null, warningBlocking: false };
      }
```

```ts
      return {
        ...base,
        amountCents,
        warning: `Prorated for ${days} day${days === 1 ? '' : 's'} — check this figure.`,
        warningBlocking: false,
      };
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx jest src/lib/__tests__/payroll-reporting.test.ts`
Expected: PASS.

- [ ] **Step 6: Full suite and typecheck**

Run: `npx jest && npx tsc --noEmit`
Expected: `Test Suites: 12 passed`, `Tests: 235 passed` (231 + 4 new). No TypeScript output, exit 0.

`PayrollDraftLine` is an internal type consumed only by `createPayrollRun`, which spreads specific fields rather than the whole object, so adding a field to it breaks nothing. If `tsc` does report an error here, stop and report it rather than working around it — it would mean something consumes the draft type in a way this plan did not account for.

- [ ] **Step 7: Commit**

```bash
git add src/lib/payroll-reporting.ts src/lib/__tests__/payroll-reporting.test.ts
git commit -m "feat: give payroll draft warnings a severity

Only a missing pay rate blocks a post -- it produces a zero amount, which
pays a real person nothing. The clocked-in and prorated warnings are
advisory: an approximate figure is often correct, and friction that fires
on every prorated line gets clicked through without being read."
```

---

### Task 2: Persist the warnings

The columns, and the data-access changes that write and read them.

**Files:**
- Create: `supabase/migrations/20260804020000_payroll_line_warnings.sql`
- Modify: `src/types/models.ts:499-517` (`PayrollRunLine`)
- Modify: `src/lib/payroll.ts:8-20` (`mapLineRow`), `:70-83` (`createPayrollRun` insert)

**Interfaces:**
- Consumes: `PayrollDraftLine.warningBlocking` from Task 1.
- Produces:
  - `payroll_run_lines.warning` (text, null) and `.warning_blocking` (boolean, not null default false), read by Tasks 3 and 4.
  - `PayrollRunLine.warning: string | null` and `.warningBlocking: boolean`, rendered by Task 4.

The type change and `mapLineRow` must land in the same commit — adding required fields to `PayrollRunLine` without populating them in `mapLineRow` fails `tsc`.

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/20260804020000_payroll_line_warnings.sql`:

```sql
-- Draft warnings were computed and then thrown away: computePayrollDraft set a
-- `warning` on every line needing a human decision, createPayrollRun didn't
-- persist it, no column held it, and the run editor rendered nothing. The only
-- readers were unit tests, which made payroll-reporting.ts's "surfaced in the
-- editor so it's corrected before posting" comment untrue.
--
-- Both columns are frozen at draft time, exactly like pay_type/pay_rate_cents:
-- recomputing a warning at display time would let a later pay rise restate what
-- a past run appears to have flagged.
--
-- Additive and defaulted, so every already-posted run keeps warning_blocking =
-- false and stays postable/unpostable exactly as before.

alter table public.payroll_run_lines
  add column warning text null,
  add column warning_blocking boolean not null default false;

comment on column public.payroll_run_lines.warning is
  'Frozen at draft time: why this line needs a human decision. Never recomputed.';

comment on column public.payroll_run_lines.warning_blocking is
  'True when the warning must be resolved before posting. post_payroll_run enforces it against amount_cents = 0, so entering an amount clears the block while the warning survives as history.';
```

- [ ] **Step 2: Apply it locally and confirm the whole chain still builds from scratch**

Run: `supabase db reset`
Expected: ends with `Finished supabase db reset.` and no error. This proves every migration applies to an empty database in order — the check that catches a migration referencing a table created by a later one.

- [ ] **Step 3: Add the fields to `PayrollRunLine`**

In `src/types/models.ts`, add to `PayrollRunLine` immediately after the existing `note` field:

```ts
  // Frozen at draft time alongside pay_type/pay_rate_cents. Never recomputed:
  // a later pay-rate change must not restate what a past run warned about.
  warning: string | null;
  warningBlocking: boolean;
```

- [ ] **Step 4: Read and write the new columns**

In `src/lib/payroll.ts`, add to `mapLineRow`'s returned object, after `note`:

```ts
    warning: row.warning ?? null,
    warningBlocking: row.warning_blocking ?? false,
```

In `createPayrollRun`, add to the object inside `lines.map(...)`, after `amount_cents`:

```ts
        warning: line.warning,
        warning_blocking: line.warningBlocking,
```

- [ ] **Step 5: Verify**

Run: `npx jest && npx tsc --noEmit && npx expo lint`
Expected: `Test Suites: 12 passed`, `Tests: 235 passed`; no TypeScript output; lint at 42 problems, no new ones.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20260804020000_payroll_line_warnings.sql src/types/models.ts src/lib/payroll.ts
git commit -m "feat: persist payroll draft warnings

createPayrollRun computed a warning for each line and dropped it on the
floor. Both columns are frozen at draft time like pay_type/pay_rate_cents,
so a later pay rise can't restate what a past run flagged."
```

---

### Task 3: Block posting a zero-amount blocking line

Safety-critical SQL. This one has a real database test, not just review.

**Files:**
- Create: `supabase/migrations/20260804020100_payroll_post_blocking_guard.sql`
- Modify: `supabase/tests/verify-accounting-writes.sql` (insert a block after the overlap test, before the unpost test at line ~199)

**Interfaces:**
- Consumes: `payroll_run_lines.warning_blocking` and `.amount_cents` from Task 2.
- Produces: `post_payroll_run(uuid)` raises when any line has `warning_blocking = true AND amount_cents = 0`. Signature unchanged.

- [ ] **Step 1: Add the database test first**

In `supabase/tests/verify-accounting-writes.sql`, insert this immediately **before** the `--- unposting removes the generated expense ---` block (around line 199). It follows the file's existing inline `declare … begin … end;` pattern:

```sql
  raise notice '--- a blocking warning with no amount is rejected ---';
  declare v_block_id uuid;
  begin
    insert into public.payroll_runs (shop_id, period_start, period_end)
      values (v_shop_id, '2026-09-01', '2026-09-07') returning id into v_block_id;
    insert into public.payroll_run_lines (payroll_run_id, shop_member_id, member_name, amount_cents, warning, warning_blocking)
      values (v_block_id, v_member_id, 'Verify Staff', 0, 'No pay rate set', true);
    -- A second, healthy line so the run's total is positive. Without it the
    -- run would also trip the "nothing to pay" guard, and the test couldn't
    -- tell which guard actually fired.
    insert into public.payroll_run_lines (payroll_run_id, shop_member_id, member_name, amount_cents)
      values (v_block_id, v_member_id, 'Verify Staff Two', 5000);

    v_raised := false;
    begin
      perform public.post_payroll_run(v_block_id);
    exception when others then
      v_raised := true;
    end;
    if not v_raised then raise exception 'FAIL: a blocking zero-amount line was posted'; end if;
    raise notice 'OK: blocking zero-amount line rejected';

    raise notice '--- entering an amount clears the block, warning survives ---';
    update public.payroll_run_lines set amount_cents = 3000
      where payroll_run_id = v_block_id and warning_blocking;
    perform public.post_payroll_run(v_block_id);

    select status into v_status from public.payroll_runs where id = v_block_id;
    if v_status <> 'posted' then raise exception 'FAIL: run status % after an amount was entered', v_status; end if;
    -- The guard tests the amount, not the warning, so the warning must still be
    -- on the row afterwards as audit history.
    select count(*) into v_count from public.payroll_run_lines
      where payroll_run_id = v_block_id and warning_blocking and warning is not null;
    if v_count <> 1 then raise exception 'FAIL: the warning did not survive posting'; end if;
    raise notice 'OK: amount unblocked the post and the warning survived';
  end;
```

The September period is deliberate — it must not overlap the August run posted earlier in the file, or the overlap guard would fire instead and the test would pass for the wrong reason.

- [ ] **Step 2: Run the database tests to verify the new block fails**

Run:
```bash
supabase db reset && psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -f supabase/tests/verify-accounting-writes.sql
```
Expected: FAIL at `FAIL: a blocking zero-amount line was posted` — the guard does not exist yet, so the run posts. Everything before that point should still print `OK:`.

- [ ] **Step 3: Write the guard**

Create `supabase/migrations/20260804020100_payroll_post_blocking_guard.sql`. The function is recreated in full, matching this file's existing convention of replacing rather than patching:

```sql
-- Refuses to post a run whose line warns of a missing pay rate and still has no
-- amount. That case pays a real person zero and records it in the P&L as fact.
--
-- The guard tests amount_cents = 0 rather than the presence of the warning, so
-- typing an amount into the run editor clears the block -- which is what the
-- editor is for (a one-off contractor, a mid-period joiner, an agreed
-- correction). The warning stays on the row afterwards as audit history, so
-- resolving it is not the same as erasing it.
--
-- Placed before the "nothing to pay" check: a run whose only lines are blocked
-- would trip both, and naming the person is more useful than "nothing to pay".

create or replace function public.post_payroll_run(p_run_id uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_run public.payroll_runs%rowtype;
  v_total integer;
  v_expense_id uuid;
  v_overlap_count integer;
  v_blocked_names text;
begin
  select * into v_run from public.payroll_runs where id = p_run_id for update;
  if v_run.id is null then
    raise exception 'pay run % not found', p_run_id;
  end if;
  if not (public.has_shop_permission(v_run.shop_id, 'people.payroll.manage')
          and public.has_shop_permission(v_run.shop_id, 'expenses.manage')) then
    raise exception 'not authorized to post pay runs for shop %', v_run.shop_id;
  end if;
  if v_run.status = 'posted' then
    raise exception 'this pay run has already been posted';
  end if;

  select count(*) into v_overlap_count
    from public.payroll_runs r
    where r.shop_id = v_run.shop_id
      and r.id <> v_run.id
      and r.status = 'posted'
      and r.period_start <= v_run.period_end
      and r.period_end >= v_run.period_start;
  if v_overlap_count > 0 then
    raise exception 'another posted pay run already covers part of % to %', v_run.period_start, v_run.period_end;
  end if;

  select string_agg(coalesce(member_name, 'A staff member'), ', ' order by member_name)
    into v_blocked_names
    from public.payroll_run_lines
    where payroll_run_id = p_run_id
      and warning_blocking
      and amount_cents = 0;
  if v_blocked_names is not null then
    raise exception 'no amount set for % — enter an amount, or set a pay rate in People', v_blocked_names;
  end if;

  select coalesce(sum(amount_cents), 0) into v_total
    from public.payroll_run_lines where payroll_run_id = p_run_id;
  if v_total <= 0 then
    raise exception 'this pay run has nothing to pay';
  end if;

  insert into public.expenses (shop_id, occurred_on, amount_cents, category, payment_method, note, created_by, payroll_run_id)
    values (
      v_run.shop_id,
      v_run.period_end,
      v_total,
      'salaries_wages',
      'cash',
      'Payroll ' || v_run.period_start || ' to ' || v_run.period_end,
      auth.uid(),
      v_run.id
    )
    returning id into v_expense_id;

  update public.payroll_runs set
    status = 'posted',
    total_cents = v_total,
    expense_id = v_expense_id,
    posted_at = now(),
    posted_by = auth.uid(),
    updated_at = now()
  where id = p_run_id;

  return v_expense_id;
end;
$$;

grant execute on function public.post_payroll_run(uuid) to authenticated;
```

- [ ] **Step 4: Run the database tests to verify they pass**

Run:
```bash
supabase db reset && psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -f supabase/tests/verify-accounting-writes.sql
```
Expected: ends with `################  ALL CHECKS PASSED  ################` and `Rolled back — no rows left behind.`, including the two new `OK:` lines.

- [ ] **Step 5: Confirm the JS suite is untouched**

Run: `npx jest && npx tsc --noEmit`
Expected: `Test Suites: 12 passed`, `Tests: 235 passed`; no TypeScript output. This task changes no TypeScript.

- [ ] **Step 6: Document the new coverage**

In `supabase/tests/README.md`, extend item 5 of the "What `verify-accounting-writes.sql` covers" list to read:

```markdown
5. Posting a pay run writes one `salaries_wages` expense dated **period end**;
   posting twice is rejected; a period overlapping an already-posted run is
   rejected; a line that warns of a missing pay rate and has no amount is
   rejected, but posts once an amount is entered — and keeps its warning;
   unposting removes the expense and returns the run to draft.
```

- [ ] **Step 7: Commit**

```bash
git add supabase/migrations/20260804020100_payroll_post_blocking_guard.sql supabase/tests/verify-accounting-writes.sql supabase/tests/README.md
git commit -m "feat: refuse to post a blocking line with no amount

A line warning of a missing pay rate produces a zero amount -- a real
person paid nothing, recorded in the P&L as fact. The guard tests
amount_cents = 0 rather than the warning itself, so entering an amount
clears the block while the warning survives as history.

The error names the people rather than the period; a date range isn't
actionable. Covered by verify-accounting-writes.sql in both directions:
blocked when zero, posts once an amount is set."
```

---

### Task 4: Show the warnings

**Files:**
- Modify: `src/components/accounting/payroll-run-editor.tsx:32-34` (derive blocked lines), `:99-108` (Post button), `:160-179` (`PayrollLineRow`), `:196-225` (styles)

**Interfaces:**
- Consumes: `PayrollRunLine.warning` and `.warningBlocking` from Tasks 1-2.
- Produces: nothing. This is the last task.

There is no React Native testing library in `devDependencies`, so this task is verified by typecheck, lint, and the unchanged JS suite. The severity logic it renders is already covered by Task 1's tests.

- [ ] **Step 1: Render the warning on each line**

In `PayrollLineRow`, inside `<View style={styles.lineMain}>`, add after the existing `lineBasis` Text:

```tsx
        {line.warning && (
          <Text style={line.warningBlocking ? styles.lineWarningBlocking : styles.lineWarning}>{line.warning}</Text>
        )}
```

- [ ] **Step 2: Add the two styles**

In the `StyleSheet.create` block, add after the existing `lineBasis` entry:

```ts
  lineWarning: { fontSize: 11, fontWeight: '600', color: '#B7791F', marginTop: 3 },
  lineWarningBlocking: { fontSize: 11, fontWeight: '700', color: '#C0392B', marginTop: 3 },
```

`#C0392B` is the danger colour already used by `styles.dangerText` and the error text; the amber is reserved for advisory so the two read as different weights of problem at a glance.

- [ ] **Step 3: Derive the blocked lines**

In the component body, immediately after `const total = draftTotalCents(lines);`, add:

```tsx
  // Mirrors post_payroll_run's guard exactly: a blocking warning only stops a
  // post while the amount is still zero, so typing one in clears it here too.
  const blockedNames = lines
    .filter((line) => line.warningBlocking && line.amountCents === 0)
    .map((line) => line.memberName ?? 'A staff member');
```

- [ ] **Step 4: Disable Post and say why**

Replace the draft-branch note and Post button (currently `payroll-run-editor.tsx:99-108`) with:

```tsx
                {blockedNames.length > 0 ? (
                  <Text style={styles.blockedNote}>
                    Enter an amount for {blockedNames.join(', ')} before posting, or set a pay rate in People.
                  </Text>
                ) : (
                  <Text style={styles.note}>
                    Posting adds {formatAccountingCents(total)} to expenses dated {run.periodEnd}. A period can only be posted
                    once.
                  </Text>
                )}
                <Pressable
                  onPress={() => run_(onPost, 'Could not post this run.')}
                  disabled={busy || total <= 0 || blockedNames.length > 0}
                  style={[styles.primaryButton, (busy || total <= 0 || blockedNames.length > 0) && styles.buttonDisabled]}
                >
                  <Text style={styles.primaryButtonText}>{busy ? 'Posting…' : 'Post pay run'}</Text>
                </Pressable>
```

- [ ] **Step 5: Add the blocked-note style**

In the `StyleSheet.create` block, add after the existing `note` entry:

```ts
  blockedNote: { fontSize: 11, fontWeight: '700', color: '#C0392B', lineHeight: 16, marginTop: 16 },
```

- [ ] **Step 6: Verify**

Run: `npx jest && npx tsc --noEmit && npx expo lint`
Expected: `Test Suites: 12 passed`, `Tests: 235 passed`; no TypeScript output; lint at 42 problems, no new ones.

- [ ] **Step 7: Confirm the UI guard matches the database guard**

Run: `grep -n "warningBlocking" src/components/accounting/payroll-run-editor.tsx`
Expected: exactly two hits — the per-line render and the `blockedNames` filter. The filter must read `line.warningBlocking && line.amountCents === 0`, matching `post_payroll_run`'s `warning_blocking and amount_cents = 0`. If the two ever disagree, the button enables and the post then fails server-side with a confusing error.

- [ ] **Step 8: Commit**

```bash
git add src/components/accounting/payroll-run-editor.tsx
git commit -m "feat: show payroll draft warnings in the run editor

Warnings were computed at draft time and never rendered. Each line now
shows its warning, blocking ones in the danger colour and advisory ones
in amber, and Post is disabled while a blocking line still has no amount
-- mirroring post_payroll_run's guard so the button and the database
agree about what is postable."
```

---

## Done when

- `npx jest` reports 12 suites / 235 tests passing.
- `npx tsc --noEmit` and `npx expo lint` are clean (lint at its 42-problem baseline).
- `supabase db reset && psql "$DB_URL" -f supabase/tests/verify-accounting-writes.sql` ends with `ALL CHECKS PASSED`, including the two new payroll checks.
- A draft line with no pay rate shows a red warning and disables Post, naming the member.
- Typing an amount on that line re-enables Post, and the warning is still visible afterwards.
- A prorated line shows an amber warning and does not block anything.

## Deliberately not done here

- **Pay cadence, pay-period generation, the per-member overlap guard, and the accrual rework** — the cadence spec, which ships next and is the reason this one ships first.
- **New warning conditions.** This surfaces the three that already exist.
- **Acknowledging or dismissing advisory warnings.** No per-line "reviewed" state: friction that fires on every prorated line gets clicked through without being read, which manufactures false confidence.
- **Backfilling warnings onto existing posted runs.** They were drafted without the field; recomputing for them is exactly the restatement this design rejects.
- **`supabase db push`.** Local verification only; applying to the remote is a separate, deliberate act.
