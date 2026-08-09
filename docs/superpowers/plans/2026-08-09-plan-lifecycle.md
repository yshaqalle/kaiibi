# Plan Lifecycle (Create / Publish / Archive) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close both ends of the plan lifecycle in the platform portal: create a plan (born hidden), publish it deliberately, and archive/restore a drained one — never delete.

**Architecture:** Four edge-function changes (`upsert_plan` create mode, new `publish_plan` / `archive_plan` / `restore_plan`, `active` guards on `set_plan` / `approve_plan_change`) with every client control a mirror of a server guard, per the portal's existing "never offer a button the server rejects" rule. Client-side the guard mirrors live as pure predicates in a new `src/lib/plan-lifecycle.ts` (Jest-tested, like `resolveRetiredPlan`), consumed by a ghost cell + create-mode editor + archived strip on the Plans tab. No schema changes at all.

**Tech Stack:** Deno edge function (`supabase/functions/platform-admin`), React Native / Expo with TypeScript, Jest, `psql`-run SQL verification scripts.

Spec: `docs/superpowers/specs/2026-08-09-plan-lifecycle-design.md`
Mockup: `docs/design/plan-lifecycle-mockup.html`

## Global Constraints

- **No delete anywhere.** `shop_subscriptions.plan_id` is `on delete restrict` by design; archive (`active = false`) is the terminal state.
- **Created hidden is a server property.** Create mode forces `is_public = false`; there is no client input for it. The only path to the picker is `publish_plan`.
- **The `trial` tripwire:** `publish_plan` and `archive_plan` refuse the key `trial` by name. Trial is $0 with every module; publishing it makes the product free, archiving it breaks the signup trigger.
- **Mirror rule:** every client visibility predicate must match the server guards exactly — a visible button the server rejects is a bug, and so is a hidden button the server would accept.
- **Plan key shape:** `^[a-z][a-z0-9_]*$`, validated server-side and client-side with the same regex.
- **Store-facing code untouched:** `listPlans()` and `listAllPlans()` keep their filters; only the portal reads inactive rows, via the new `listPlansForPlatform()`.
- All Bento styling uses tokens from `src/constants/theme.ts` (`Colors.light`, `BENTO_RADIUS`, `BENTO_RADIUS_TILE`) — never a hex literal in a screen.
- Every platform action carries a mandatory operator `reason` (audit log).
- The Deno edge function has no automated test harness in this repo (no `deno` on this machine); its guard logic is mirrored and Jest-tested in `src/lib/plan-lifecycle.ts`, and DB-level invariants it rests on are asserted in `supabase/tests/verify-platform-portal.sql`.

## File map

| File | Change | Tasks |
|---|---|---|
| `supabase/functions/platform-admin/index.ts` | `upsert_plan` create mode; `publish_plan` / `archive_plan` / `restore_plan` cases; `active` guards on `set_plan` and `approve_plan_change` | 1, 2, 3, 4 |
| `supabase/tests/verify-platform-portal.sql` | Assert the delete-restrict invariant archive rests on | 3 |
| `src/lib/subscriptions.ts` | `Plan` gains `active` + `updatedAt`; new `listPlansForPlatform()` | 5 |
| `src/lib/plan-lifecycle.ts` | Create: `isValidPlanKey`, `canPublishPlan`, `canArchivePlan` | 5 |
| `src/lib/__tests__/plan-lifecycle.test.ts` | Create: Jest coverage of all three predicates | 5 |
| `src/components/platform/plan-editor.tsx` | `plan: Plan \| null` — create mode | 6 |
| `src/components/platform/plan-lifecycle-modal.tsx` | Create: one confirm sheet for publish / archive / restore | 7 |
| `src/components/platform/plans-tab.tsx` | Ghost cell, Publish/Archive buttons, archived strip, modal wiring | 8 |
| `src/app/platform/index.tsx` | Fetch via `listPlansForPlatform()`, split active/archived | 8 |

---

### Task 1: `upsert_plan` create mode (server)

**Files:**
- Modify: `supabase/functions/platform-admin/index.ts` — `RequestBody` (line 54, after `plan?`), the `upsert_plan` case (lines 344–382)

**Interfaces:**
- Consumes: nothing new.
- Produces: `upsert_plan` accepts `create?: boolean` in the body. In create mode it 400s on a malformed key, 409s (`key_exists`) on an existing key, and inserts with `is_public: false`. Edit mode is byte-for-byte unchanged. Clients call it as `callPlatformAdmin('upsert_plan', { plan: {...}, create: true }, reason)`.

- [ ] **Step 1: Add the `create` flag to `RequestBody`**

In `supabase/functions/platform-admin/index.ts`, after the `plan?: Record<string, unknown>;` field (line 54), add:

```ts
  // upsert_plan only. When set, the upsert must INSERT: an existing key is a
  // 409 rather than a silent overwrite, the key shape is validated, and the
  // row is forced non-public so a new plan can never appear in the store
  // picker before an operator has looked at its card and published it.
  create?: boolean;
```

- [ ] **Step 2: Rework the `upsert_plan` case**

Replace the body of `case 'upsert_plan':` (currently lines 344–382). The allowlist and its comment stay; the "Tradeoff worth naming" paragraph in that comment is now resolved, so it changes too. The full new case:

```ts
      case 'upsert_plan': {
        if (!body.plan) return errorResponse(400, 'unknown', 'plan is required.');
        const key = body.plan.key as string | undefined;
        if (!key) return errorResponse(400, 'unknown', 'plan.key is required.');

        // Allowlist, not a spread. Retirement has its own audited action
        // (retire_plan / republish_plan) and must not be settable here:
        // `retire_at` and `successor_plan_key` sent through this path would set
        // a retirement with no successor validation, which is exactly how a
        // two-hop chain gets created -- and shop_effective_plan() follows only
        // one hop. `is_public` is the other half of that same state (retiring
        // clears it, republishing restores it) and is likewise never accepted
        // here: publishing goes through publish_plan and its guards or not at
        // all. Create mode is the one place this handler touches the column,
        // and only to force it FALSE -- a new plan is born hidden as a server
        // property, not a portal convention. `active` belongs to
        // archive_plan / restore_plan for the same reason.
        const editable = ['key', 'name', 'description', 'price_cents', 'currency', 'billing_interval', 'modules', 'limits', 'sort_order'] as const;
        const planPayload: Record<string, unknown> = {};
        for (const column of editable) {
          if (column in body.plan) planPayload[column] = body.plan[column];
        }

        const { data: before, error: beforeError } = await adminClient.from('plans').select('*').eq('key', key).maybeSingle();
        if (beforeError) return errorResponse(500, 'unknown', beforeError.message);

        if (body.create) {
          // The key becomes the audit and billing identifier and can never
          // change, so a typo'd shape is refused rather than lived with.
          if (!/^[a-z][a-z0-9_]*$/.test(key)) {
            return errorResponse(400, 'unknown', 'Plan keys are lowercase letters, digits and underscores, starting with a letter.');
          }
          // Without this, typing `standard` into the create sheet would
          // silently rewrite Standard for every store on it.
          if (before) {
            return errorResponse(409, 'key_exists', `A plan with key \`${key}\` already exists.`);
          }
          planPayload.is_public = false;
        }

        const { data: after, error } = await adminClient
          .from('plans')
          .upsert({ ...planPayload, updated_at: new Date().toISOString() }, { onConflict: 'key' })
          .select('*')
          .single();
        if (error) return errorResponse(500, 'unknown', error.message);
        // No target shop: editing a plan changes entitlements for every shop on
        // it at once, which is exactly why the portal shows how many that is
        // before saving.
        await audit('upsert_plan', null, before, after);
        return ok({ plan: after });
      }
```

- [ ] **Step 3: Commit**

```bash
git add supabase/functions/platform-admin/index.ts
git commit -m "feat(platform): upsert_plan create mode — insert-only, key-validated, born hidden"
```

---

### Task 2: `publish_plan` action (server)

**Files:**
- Modify: `supabase/functions/platform-admin/index.ts` — `Action` union (line 16), a new case immediately after the `republish_plan` case closes (after line 686)

**Interfaces:**
- Consumes: nothing new.
- Produces: `publish_plan` — `{ planKey: string }` → `{ plan }`. Rejects `trial` (400), missing plan (400), archived (409 `plan_archived`), retiring (409 `plan_retiring`), already public (400). Called as `callPlatformAdmin('publish_plan', { planKey }, reason)`.

- [ ] **Step 1: Add to the `Action` union**

In the `Action` union (line 16), after `| 'republish_plan'`:

```ts
  | 'publish_plan'
  | 'archive_plan'
  | 'restore_plan'
```

(All three at once — Tasks 2 and 3 share this union edit; whichever task runs first makes it.)

- [ ] **Step 2: Write the case**

Insert immediately after the `republish_plan` case closes (after line 686, before `case 'set_platform_settings'`):

```ts
      case 'publish_plan': {
        if (!body.planKey) return errorResponse(400, 'unknown', 'planKey is required.');
        // The same tripwire republish_plan's retire_at guard provides, but
        // publish has no retirement state to hide behind: `trial` is $0,
        // carries every module and has no limits, and the store-facing chooser
        // lists on is_public alone. One benign-looking call would make the
        // whole product free, so the key is refused by name.
        if (body.planKey === 'trial') {
          return errorResponse(400, 'unknown', 'The trial plan is assigned by trigger and can never be published.');
        }
        const { data: before, error: beforeError } = await adminClient.from('plans').select('*').eq('key', body.planKey).maybeSingle();
        if (beforeError) return errorResponse(500, 'unknown', beforeError.message);
        if (!before) return errorResponse(400, 'unknown', 'No such plan.');
        if (!before.active) {
          return errorResponse(409, 'plan_archived', `${before.name} is archived. Restore it before publishing.`);
        }
        // Republish is the verb for a retiring plan -- it clears retire_at and
        // successor_plan_key in the same write. Publishing here instead would
        // mint a public-but-retiring plan, a state nothing else can produce.
        if (before.retire_at) {
          return errorResponse(409, 'plan_retiring', `${before.name} is being retired. Republish it instead — that clears the retirement.`);
        }
        if (before.is_public) return errorResponse(400, 'unknown', `${before.name} is already public.`);

        const { data: after, error } = await adminClient
          .from('plans')
          .update({ is_public: true, updated_at: new Date().toISOString() })
          .eq('key', body.planKey)
          .select('*')
          .single();
        if (error) return errorResponse(500, 'unknown', error.message);
        await audit('publish_plan', null, before, after);
        return ok({ plan: after });
      }
```

- [ ] **Step 3: Commit**

```bash
git add supabase/functions/platform-admin/index.ts
git commit -m "feat(platform): publish_plan — the one door from hidden to the store picker"
```

---

### Task 3: `archive_plan` / `restore_plan` actions + the invariant they rest on (server + SQL test)

**Files:**
- Modify: `supabase/functions/platform-admin/index.ts` — two new cases immediately after the `publish_plan` case from Task 2 (if Task 2 hasn't run, after `republish_plan` at line 686; also make the Task 2 Step 1 union edit if absent)
- Modify: `supabase/tests/verify-platform-portal.sql` — append one section before `raise notice 'ALL CHECKS PASSED'`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `archive_plan` — `{ planKey: string }` → `{ plan }`. Rejects `trial` (400), missing (400), already archived (400), still public (409 `plan_public`), referenced by any subscription row (409 `plan_in_use`), the post-trial fallback (409 `plan_is_fallback`), named as any plan's successor (409 `plan_is_successor`).
  - `restore_plan` — `{ planKey: string }` → `{ plan }`. Rejects missing (400) and not-archived (400).

- [ ] **Step 1: Write the failing SQL invariant test**

In `supabase/tests/verify-platform-portal.sql`, immediately before `raise notice 'ALL CHECKS PASSED';` (after the retirement-invariants section), append:

```sql
  -- ------------------------------------ archive invariants the guards rest on
  -- archive_plan (active = false) exists because DELETE must stay impossible
  -- while any subscription row points at the plan. Prove the restrict actually
  -- bites: the verify shop's subscription points at `trial`, so deleting it
  -- must fail loudly rather than strip entitlements.
  begin
    delete from public.plans where key = 'trial';
    raise exception 'FAIL: deleting a plan with live subscriptions was allowed';
  exception when foreign_key_violation then
    null;
  end;
```

- [ ] **Step 2: Run the SQL test to verify it passes**

(The invariant already holds — this asserts the ground the new guards stand on, so a future FK change fails loudly.) With local Supabase running:

```bash
supabase db reset && psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
  -f supabase/tests/verify-platform-portal.sql
```

Expected: `NOTICE: ALL CHECKS PASSED` and `CLEAN: no rows left behind`.

- [ ] **Step 3: Write the two cases**

In `supabase/functions/platform-admin/index.ts`, insert immediately after the `publish_plan` case from Task 2 (ensure the `Action` union contains `'archive_plan'` and `'restore_plan'` — Task 2 Step 1 adds all three):

```ts
      case 'archive_plan': {
        if (!body.planKey) return errorResponse(400, 'unknown', 'planKey is required.');
        // The provisioning trigger selects `trial` by key at every shop
        // creation; archiving it would break signup platform-wide.
        if (body.planKey === 'trial') {
          return errorResponse(400, 'unknown', 'The trial plan is selected by the signup trigger and can never be archived.');
        }
        const { data: before, error: beforeError } = await adminClient.from('plans').select('*').eq('key', body.planKey).maybeSingle();
        if (beforeError) return errorResponse(500, 'unknown', beforeError.message);
        if (!before) return errorResponse(400, 'unknown', 'No such plan.');
        if (!before.active) return errorResponse(400, 'unknown', `${before.name} is already archived.`);
        // Off the picker first: retire it, or it was never published.
        if (before.is_public) {
          return errorResponse(409, 'plan_public', `${before.name} is still in the store-facing picker. Retire it first.`);
        }
        // All rows, any status -- plan_id's on-delete-restrict makes no status
        // distinction and neither does this. A lapsed store's subscription row
        // still names the plan it will return to.
        const { count, error: subsError } = await adminClient
          .from('shop_subscriptions')
          .select('id', { count: 'exact', head: true })
          .eq('plan_id', before.id);
        if (subsError) return errorResponse(500, 'unknown', subsError.message);
        if ((count ?? 0) > 0) {
          return errorResponse(409, 'plan_in_use', `${count} subscription${count === 1 ? ' still points' : 's still point'} at ${before.name}. Move them first.`);
        }
        // Lapsed stores resolve through post_trial_plan_key on every
        // entitlement read; archiving that plan strands all of them.
        const { data: settings, error: settingsError } = await adminClient
          .from('platform_settings').select('post_trial_plan_key').eq('id', true).maybeSingle();
        if (settingsError) return errorResponse(500, 'unknown', settingsError.message);
        if (settings?.post_trial_plan_key === body.planKey) {
          return errorResponse(409, 'plan_is_fallback', `${before.name} is the post-trial fallback plan. Point the fallback elsewhere first.`);
        }
        // retire_plan refuses an inactive successor at set time; this closes
        // the same hole from the other side -- an in-flight retirement must
        // not sweep its stores onto an archived plan on the retire date.
        const { data: pointing, error: pointingError } = await adminClient
          .from('plans').select('name').eq('successor_plan_key', body.planKey);
        if (pointingError) return errorResponse(500, 'unknown', pointingError.message);
        if (pointing && pointing.length > 0) {
          return errorResponse(
            409,
            'plan_is_successor',
            `${pointing.map((p) => p.name).join(', ')} retire${pointing.length === 1 ? 's' : ''} into ${before.name}. Republish or re-point ${pointing.length === 1 ? 'it' : 'them'} first.`
          );
        }

        const { data: after, error } = await adminClient
          .from('plans')
          .update({ active: false, updated_at: new Date().toISOString() })
          .eq('key', body.planKey)
          .select('*')
          .single();
        if (error) return errorResponse(500, 'unknown', error.message);
        await audit('archive_plan', null, before, after);
        return ok({ plan: after });
      }

      case 'restore_plan': {
        if (!body.planKey) return errorResponse(400, 'unknown', 'planKey is required.');
        const { data: before, error: beforeError } = await adminClient.from('plans').select('*').eq('key', body.planKey).maybeSingle();
        if (beforeError) return errorResponse(500, 'unknown', beforeError.message);
        if (!before) return errorResponse(400, 'unknown', 'No such plan.');
        if (before.active) return errorResponse(400, 'unknown', `${before.name} is not archived.`);

        // active = true and nothing else: is_public and retire_at are
        // untouched, so the plan comes back exactly as it went away -- hidden,
        // and still retired if it was -- and restoring can never surprise the
        // store-facing picker.
        const { data: after, error } = await adminClient
          .from('plans')
          .update({ active: true, updated_at: new Date().toISOString() })
          .eq('key', body.planKey)
          .select('*')
          .single();
        if (error) return errorResponse(500, 'unknown', error.message);
        await audit('restore_plan', null, before, after);
        return ok({ plan: after });
      }
```

- [ ] **Step 4: Commit**

```bash
git add supabase/functions/platform-admin/index.ts supabase/tests/verify-platform-portal.sql
git commit -m "feat(platform): archive_plan / restore_plan — the guarded active=false door"
```

---

### Task 4: `active` guards on `set_plan` and `approve_plan_change` (server)

**Files:**
- Modify: `supabase/functions/platform-admin/index.ts` — the `set_plan` case (select at line 163, guard after line 177) and the `approve_plan_change` requested-plan check (select at line 756, guard after line 769)

**Interfaces:**
- Consumes: nothing new.
- Produces: both actions 409 (`plan_archived`) when the target plan has `active = false`.

**Why:** both currently guard `retire_at` only. An archived **retired** plan is already caught by that (nothing but republish ever clears `retire_at`), but an archived never-launched draft has `retire_at = null` and would pass — a store moved onto an inactive plan by a path that skips every archive guard, instantly violating the "no subscriptions point at an archived plan" invariant Task 3 establishes.

- [ ] **Step 1: Guard `set_plan`**

At line 163, add `active` to the select:

```ts
        const { data: plan, error: planError } = await adminClient.from('plans').select('id, key, name, retire_at, active').eq('key', body.planKey).maybeSingle();
```

After the `plan_retiring` rejection closes (line 177), add:

```ts
        // An archived retired plan is already caught by the retire_at guard
        // above (nothing but republish clears retire_at), but an archived
        // never-launched draft has retire_at = null and would slip through --
        // pointing a subscription at an inactive plan by a path that skips
        // every archive_plan guard.
        if (!plan.active) {
          return errorResponse(409, 'plan_archived', `${plan.name} is archived, so stores cannot be moved onto it.`);
        }
```

- [ ] **Step 2: Guard `approve_plan_change`**

At line 756, add `active` to the select:

```ts
            .from('plans').select('name, retire_at, active').eq('id', request.requested_plan_id).maybeSingle();
```

After the `plan_retiring` rejection inside the `approve_plan_change` branch (line 769), add:

```ts
          // Same reasoning as set_plan's active guard: an archived
          // never-retired draft passes the retire_at check above.
          if (requestedPlan && !requestedPlan.active) {
            return errorResponse(409, 'plan_archived', `${requestedPlan.name} is archived, so stores cannot be moved onto it. Decline this request.`);
          }
```

- [ ] **Step 3: Commit**

```bash
git add supabase/functions/platform-admin/index.ts
git commit -m "fix(platform): set_plan and approve_plan_change refuse archived target plans"
```

---

### Task 5: `Plan.active`, `listPlansForPlatform()`, and the guard-mirror predicates (lib + Jest)

**Files:**
- Modify: `src/lib/subscriptions.ts` — the `Plan` type (line 13), `mapPlanRow` (line 35), new function after `listAllPlans` (line 64)
- Create: `src/lib/plan-lifecycle.ts`
- Create: `src/lib/__tests__/plan-lifecycle.test.ts`

**Interfaces:**
- Consumes: `Plan` from `@/lib/subscriptions`.
- Produces:
  - `Plan` gains `active: boolean` and `updatedAt: string`.
  - `listPlansForPlatform(): Promise<Plan[]>` — every row, inactive included, ordered by `sort_order`.
  - `isValidPlanKey(key: string): boolean`
  - `canPublishPlan(plan: Pick<Plan, 'key' | 'isPublic' | 'retireAt' | 'active'>): boolean`
  - `canArchivePlan(plan: Pick<Plan, 'key' | 'isPublic' | 'active'>, ctx: { storedShopsOn: number; postTrialPlanKey: string; plans: Pick<Plan, 'successorPlanKey'>[] }): boolean`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/__tests__/plan-lifecycle.test.ts`:

```ts
// The client-side mirrors of publish_plan's and archive_plan's server guards.
// The portal's rule is that a button the server would reject is never offered
// -- which only holds if these predicates and the edge-function guards agree.
// If a guard changes in supabase/functions/platform-admin/index.ts, it changes
// here, and vice versa.

import { canArchivePlan, canPublishPlan, isValidPlanKey } from '@/lib/plan-lifecycle';

describe('isValidPlanKey', () => {
  it.each(['starter', 'pro_2025', 'a'])('accepts %s', (key) => {
    expect(isValidPlanKey(key)).toBe(true);
  });

  it.each(['Standard', '9lives', 'has-dash', 'has space', '_leading', ''])('rejects %s', (key) => {
    expect(isValidPlanKey(key)).toBe(false);
  });
});

const hiddenDraft = { key: 'starter', isPublic: false, retireAt: null, active: true };

describe('canPublishPlan', () => {
  it('offers publish for a hidden, active, never-retiring plan', () => {
    expect(canPublishPlan(hiddenDraft)).toBe(true);
  });

  it('never offers publish for trial — the make-the-product-free tripwire', () => {
    expect(canPublishPlan({ ...hiddenDraft, key: 'trial' })).toBe(false);
  });

  it('does not offer publish for an already-public plan', () => {
    expect(canPublishPlan({ ...hiddenDraft, isPublic: true })).toBe(false);
  });

  it('does not offer publish for a retiring plan — republish is the verb there', () => {
    expect(canPublishPlan({ ...hiddenDraft, retireAt: '2999-01-01T00:00:00.000Z' })).toBe(false);
  });

  it('does not offer publish for an archived plan', () => {
    expect(canPublishPlan({ ...hiddenDraft, active: false })).toBe(false);
  });
});

const drained = { key: 'free', isPublic: false, active: true };
const ctx = { storedShopsOn: 0, postTrialPlanKey: 'standard', plans: [{ successorPlanKey: null }] };

describe('canArchivePlan', () => {
  it('offers archive for a drained, hidden plan', () => {
    expect(canArchivePlan(drained, ctx)).toBe(true);
  });

  it('a retired plan is archivable once drained — retireAt is not consulted', () => {
    // Retirement state lives on the row and survives archiving; the predicate
    // deliberately ignores it, matching archive_plan.
    expect(canArchivePlan({ ...drained, key: 'legacy' }, ctx)).toBe(true);
  });

  it('does not offer archive while any subscription row points at it', () => {
    expect(canArchivePlan(drained, { ...ctx, storedShopsOn: 3 })).toBe(false);
  });

  it('does not offer archive for a public plan — retire first', () => {
    expect(canArchivePlan({ ...drained, isPublic: true }, ctx)).toBe(false);
  });

  it('never offers archive for trial — the signup trigger selects it by key', () => {
    expect(canArchivePlan({ ...drained, key: 'trial' }, ctx)).toBe(false);
  });

  it('does not offer archive for the post-trial fallback plan', () => {
    expect(canArchivePlan(drained, { ...ctx, postTrialPlanKey: 'free' })).toBe(false);
  });

  it('does not offer archive for a plan named as a retirement successor', () => {
    expect(canArchivePlan(drained, { ...ctx, plans: [{ successorPlanKey: 'free' }] })).toBe(false);
  });

  it('does not offer archive for an already-archived plan', () => {
    expect(canArchivePlan({ ...drained, active: false }, ctx)).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest src/lib/__tests__/plan-lifecycle.test.ts`
Expected: FAIL — `Cannot find module '@/lib/plan-lifecycle'`.

- [ ] **Step 3: Add `active` and `updatedAt` to `Plan`**

In `src/lib/subscriptions.ts`, in the `Plan` type after `successorPlanKey: string | null;` (line 31):

```ts
  // False is archived: the terminal state the portal uses instead of delete.
  // Only the portal ever sees inactive rows (listPlansForPlatform); every
  // store-facing listing keeps filtering them out.
  active: boolean;
  // Surfaced for the portal's archived strip: archiving is by construction
  // the last write to an archived row (the strip offers no Edit), so this is
  // honestly "when it was archived" there.
  updatedAt: string;
```

In `mapPlanRow`, after `successorPlanKey: row.successor_plan_key ?? null,` (line 48):

```ts
    active: row.active,
    updatedAt: row.updated_at,
```

- [ ] **Step 4: Add `listPlansForPlatform()`**

In `src/lib/subscriptions.ts`, after `listAllPlans` (line 64):

```ts
// Every row there is, archived included -- portal only. The archived strip on
// the Plans tab is the way back through the active=false door; a listing that
// filtered on active would make archiving irreversible from the UI.
// Store-facing code keeps listPlans/listAllPlans and their filters.
export async function listPlansForPlatform(): Promise<Plan[]> {
  const { data, error } = await supabase
    .from('plans')
    .select('*')
    .order('sort_order', { ascending: true });
  if (error) throw error;
  return (data ?? []).map(mapPlanRow);
}
```

- [ ] **Step 5: Create the predicates**

Create `src/lib/plan-lifecycle.ts`:

```ts
import type { Plan } from '@/lib/subscriptions';

// Client-side mirrors of the plan-lifecycle guards in
// supabase/functions/platform-admin/index.ts (publish_plan / archive_plan).
// The portal never offers a button the server would reject, and these
// predicates are that rule made checkable: if a guard changes there, it
// changes here.

// The server validates the same shape on create; the editor uses this to gate
// the save button rather than round-tripping for a 400.
export function isValidPlanKey(key: string): boolean {
  return /^[a-z][a-z0-9_]*$/.test(key);
}

export function canPublishPlan(plan: Pick<Plan, 'key' | 'isPublic' | 'retireAt' | 'active'>): boolean {
  return (
    plan.active &&
    !plan.isPublic &&
    // Republish is the verb for a retiring plan -- it clears the retirement.
    plan.retireAt == null &&
    // $0, every module, no limits; publishing it makes the product free.
    plan.key !== 'trial'
  );
}

export function canArchivePlan(
  plan: Pick<Plan, 'key' | 'isPublic' | 'active'>,
  ctx: {
    // Stored subscriptions, matching archive_plan's count over rows -- not the
    // effective plan, which reads zero for exactly the retired plans whose
    // stores have not moved yet.
    storedShopsOn: number;
    postTrialPlanKey: string;
    plans: Pick<Plan, 'successorPlanKey'>[];
  }
): boolean {
  return (
    plan.active &&
    !plan.isPublic &&
    // The signup trigger selects trial by key at every shop creation.
    plan.key !== 'trial' &&
    // Lapsed stores resolve through the fallback on every entitlement read.
    plan.key !== ctx.postTrialPlanKey &&
    ctx.storedShopsOn === 0 &&
    // An in-flight retirement must not sweep stores onto an archived plan.
    !ctx.plans.some((p) => p.successorPlanKey === plan.key)
  );
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx jest src/lib/__tests__/plan-lifecycle.test.ts`
Expected: PASS, 18 tests.

- [ ] **Step 7: Run the full suite to catch `Plan` shape fallout**

Run: `npx jest`
Expected: PASS. If any test builds `Plan` literals (e.g. `platform-shops.test.ts` fixtures), add `active: true, updatedAt: '2026-01-01T00:00:00.000Z'` to those fixtures — the type gained two required fields.

- [ ] **Step 8: Commit**

```bash
git add src/lib/subscriptions.ts src/lib/plan-lifecycle.ts src/lib/__tests__/plan-lifecycle.test.ts
git commit -m "feat(platform): Plan.active + listPlansForPlatform + lifecycle guard mirrors"
```

---

### Task 6: `PlanEditor` create mode

**Files:**
- Modify: `src/components/platform/plan-editor.tsx`

**Interfaces:**
- Consumes: `isValidPlanKey` from `@/lib/plan-lifecycle` (Task 5); `callPlatformAdmin('upsert_plan', { plan, create: true }, reason)` (Task 1).
- Produces: `PlanEditor`'s `plan` prop widens to `Plan | null`; `null` means create. Existing call sites (non-null) compile unchanged.

- [ ] **Step 1: Widen the props and state**

In `src/components/platform/plan-editor.tsx`, add to the imports:

```ts
import { isValidPlanKey } from '@/lib/plan-lifecycle';
```

Change the component signature and state initialisers (lines 18–41) to:

```tsx
// Editing a plan changes entitlements for every shop on it at once, with no
// further confirmation anywhere — which is why the blast radius is computed and
// shown before saving rather than described in the abstract.
//
// `plan: null` is create mode: the key becomes a field instead of a footnote,
// the blast radius never renders (nobody is on a plan that does not exist),
// and the save sends `create: true` so the server refuses to overwrite an
// existing key and forces the new row hidden.
export function PlanEditor({
  plan,
  shopsOn,
  shops,
  onClose,
  onDone,
}: {
  plan: Plan | null;
  shopsOn: number;
  shops: PlatformShopRow[];
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const creating = plan == null;
  const [key, setKey] = useState(plan?.key ?? '');
  const [name, setName] = useState(plan?.name ?? '');
  const [price, setPrice] = useState(plan ? String(plan.priceCents / 100) : '0');
  const [modules, setModules] = useState<string[]>(plan?.modules ?? []);
  // Kept as raw text, blank meaning unlimited, so an operator clearing a field
  // says "no cap" rather than being forced to invent a number.
  const [limits, setLimits] = useState<Record<string, string>>(
    Object.fromEntries(
      LIMIT_RESOURCES.map((r) => [r.key, plan == null || plan.limits[r.key] == null ? '' : String(plan.limits[r.key])])
    )
  );
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const keyOk = !creating || isValidPlanKey(key.trim());
```

- [ ] **Step 2: Guard the blast-radius computation**

Replace the `losingModules` / `strandedByLimit` block (lines 47–55) with:

```tsx
  // Who this edit actually hurts, right now, by name. Empty in create mode:
  // nobody is on a plan that does not exist yet.
  const losingModules = (plan?.modules ?? []).filter((m) => !modules.includes(m));
  const strandedByLimit = plan
    ? LIMIT_RESOURCES.flatMap((r) => {
        const raw = limits[r.key].trim();
        if (raw === '') return [];
        const next = Number(raw);
        if (!Number.isFinite(next)) return [];
        const over = shops.filter((s) => s.planKey === plan.key && (s.usage[r.key] ?? 0) > next);
        return over.length > 0 ? [`${over.length} over ${limitLabel(r.key).toLowerCase()}`] : [];
      })
    : [];
```

- [ ] **Step 3: Send `create: true` from `save`**

Replace the `callPlatformAdmin` call inside `save` (lines 65–81) with:

```ts
      await callPlatformAdmin(
        'upsert_plan',
        {
          plan: {
            key: creating ? key.trim() : plan.key,
            name: name.trim(),
            price_cents: Math.round((Number(price) || 0) * 100),
            modules,
            limits: Object.fromEntries(
              LIMIT_RESOURCES.map((r) => [r.key, limits[r.key].trim() === '' ? null : Number(limits[r.key])]).filter(
                ([, v]) => v !== null
              )
            ),
          },
          ...(creating ? { create: true } : {}),
        },
        reason.trim()
      );
```

And at the top of `save`, before the reason check, add the key gate:

```ts
    if (!keyOk) {
      setError('Plan keys are lowercase letters, digits and underscores, starting with a letter.');
      return;
    }
```

- [ ] **Step 4: The create-mode header, caveat, and footer**

Replace the `headRow` block and `meta` line (lines 93–103) with:

```tsx
      <View style={styles.headRow}>
        {creating ? (
          <LabelledField label="Key — permanent">
            <Field
              value={key}
              onChangeText={(v) => setKey(v.toLowerCase())}
              placeholder="starter"
              needed={!keyOk}
              width={130}
            />
          </LabelledField>
        ) : null}
        <LabelledField label="Name">
          <Field value={name} onChangeText={setName} style={styles.nameField} />
        </LabelledField>
        <LabelledField label={`Price (${plan?.currency ?? 'USD'})`}>
          <Field value={price} onChangeText={setPrice} keyboardType="decimal-pad" width={112} />
        </LabelledField>
      </View>
      <Text style={styles.meta}>
        {creating
          ? 'lowercase letters, digits, _ — becomes the audit and billing identifier and can never change'
          : `key \`${plan.key}\` — not editable, ${shopsOn} store${shopsOn === 1 ? '' : 's'} depend on it`}
      </Text>
```

After the limits `ActionRow` closes (line 125), before the blast-radius caveat, add:

```tsx
      {creating ? (
        <View style={styles.caveat}>
          <Caveat tone="context">
            Created hidden. No store can see or pick this plan until you publish it from its card — build it, check
            it, then flip it on.
          </Caveat>
        </View>
      ) : null}
```

Replace the footer save button (line 152) with:

```tsx
        <PlatformButton
          label={busy ? 'Saving…' : creating ? 'Create hidden plan' : 'Save plan'}
          disabled={busy || !reason.trim() || !keyOk}
          onPress={save}
        />
```

- [ ] **Step 5: Typecheck via the suite and commit**

Run: `npx jest && npx tsc --noEmit`
Expected: both clean — the widened prop must not break the existing `plan-editor` call site in `plans-tab.tsx` (it passes a non-null `Plan`).

```bash
git add src/components/platform/plan-editor.tsx
git commit -m "feat(platform): PlanEditor create mode — key field, no blast radius, born hidden"
```

---

### Task 7: The lifecycle confirm sheet (`PlanLifecycleModal`)

**Files:**
- Create: `src/components/platform/plan-lifecycle-modal.tsx`

**Interfaces:**
- Consumes: `callPlatformAdmin` (`publish_plan` / `archive_plan` / `restore_plan`, Tasks 2–3), kit components, `Plan` (with `active`, Task 5).
- Produces: `PlanLifecycleModal({ mode, plan, onClose, onDone })` with `mode: 'publish' | 'archive' | 'restore'` — one confirm sheet with per-mode copy, a mandatory reason, and the archive guard checklist. Rendered inside a `PlatformModal` by the caller (Task 8), which owns the title.

- [ ] **Step 1: Create the component**

Create `src/components/platform/plan-lifecycle-modal.tsx`:

```tsx
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { ActionRow, Field, PlatformButton, SectionLabel } from '@/components/platform/kit';
import { Colors } from '@/constants/theme';
import { formatCents } from '@/lib/currency';
import { callPlatformAdmin } from '@/lib/platform';
import type { Plan } from '@/lib/subscriptions';

// Pinned to the light palette for now — no dark-mode switching yet.
const theme = Colors.light;

// One sheet for the three one-way-ish plan switches. They share everything
// but their copy: a single audited action keyed by plan, a mandatory reason,
// and no other input. The caller only renders this when the matching
// can*Plan() predicate passed, so the sheet states consequences rather than
// re-litigating eligibility — except archive, whose checklist is shown ticked
// because "safe because" is the whole reassurance that sheet exists to give.
const ACTIONS = {
  publish: { action: 'publish_plan', button: 'Publish', danger: false },
  archive: { action: 'archive_plan', button: 'Archive plan', danger: true },
  restore: { action: 'restore_plan', button: 'Restore', danger: false },
} as const;

const ARCHIVE_CHECKS = [
  '0 subscriptions still point at it',
  'Not the post-trial fallback plan',
  'No retiring plan names it as successor',
];

export function PlanLifecycleModal({
  mode,
  plan,
  onClose,
  onDone,
}: {
  mode: keyof typeof ACTIONS;
  plan: Plan;
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    if (!reason.trim()) {
      setError('A reason is required for every change.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await callPlatformAdmin(ACTIONS[mode].action, { planKey: plan.key }, reason.trim());
      await onDone();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update that plan.');
    } finally {
      setBusy(false);
    }
  };

  const price = plan.priceCents === 0 ? 'free' : `${formatCents(plan.priceCents)}/${plan.billingInterval ?? 'month'}`;
  const limitCount = Object.values(plan.limits).filter((v) => v != null).length;

  return (
    <View>
      {mode === 'publish' ? (
        <Text style={styles.copy}>
          Appears in every store&apos;s plan picker immediately — {price}, with the {plan.modules.length} module
          {plan.modules.length === 1 ? '' : 's'} and {limitCount} limit{limitCount === 1 ? '' : 's'} it has right now.
        </Text>
      ) : mode === 'archive' ? (
        <>
          <Text style={styles.copy}>
            Puts the plan away. It leaves this tab for the Archived list below the grid — nothing is deleted, and
            Restore brings it back exactly as it is now.
          </Text>
          <SectionLabel>Safe to archive</SectionLabel>
          {ARCHIVE_CHECKS.map((check) => (
            <View key={check} style={styles.check}>
              <Text style={styles.checkGlyph}>✓</Text>
              <Text style={styles.checkText}>{check}</Text>
            </View>
          ))}
        </>
      ) : (
        <Text style={styles.copy}>
          Comes back to the grid exactly as it went away — hidden{plan.retireAt ? ' and retired' : ''} — so no
          store&apos;s plan picker changes.
        </Text>
      )}

      <SectionLabel>Reason</SectionLabel>
      <Field
        value={reason}
        onChangeText={setReason}
        placeholder="Reason (required — goes into the audit log)"
        needed={!reason.trim()}
      />
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <ActionRow style={styles.footer}>
        <PlatformButton
          label={busy ? 'Working…' : ACTIONS[mode].button}
          danger={ACTIONS[mode].danger}
          disabled={busy || !reason.trim()}
          onPress={run}
        />
        <Pressable onPress={onClose}>
          <Text style={styles.cancel}>Cancel</Text>
        </Pressable>
      </ActionRow>
    </View>
  );
}

const styles = StyleSheet.create({
  copy: { fontSize: 12.5, lineHeight: 18, color: theme.bentoInk2 },
  check: { flexDirection: 'row', alignItems: 'baseline', gap: 9, marginBottom: 7 },
  // bentoProfit is a status colour and must never stand alone — the ✓ glyph is
  // the signal; the green only underlines it.
  checkGlyph: { fontSize: 12, fontWeight: '800', color: theme.bentoProfit },
  checkText: { fontSize: 12, color: theme.bentoInk2 },
  error: { color: theme.bentoLoss, fontSize: 12, fontWeight: '700', marginTop: 8 },
  footer: { marginTop: 14 },
  cancel: { color: theme.bentoMuted, fontSize: 12, fontWeight: '700', paddingHorizontal: 8 },
});
```

- [ ] **Step 2: Typecheck and commit**

Run: `npx tsc --noEmit`
Expected: clean.

```bash
git add src/components/platform/plan-lifecycle-modal.tsx
git commit -m "feat(platform): PlanLifecycleModal — one confirm sheet for publish/archive/restore"
```

---

### Task 8: Plans tab wiring — ghost cell, buttons, archived strip, screen fetch

**Files:**
- Modify: `src/components/platform/plans-tab.tsx`
- Modify: `src/app/platform/index.tsx` — the imports (line 33), `reload` (line 98), state, and the `PlansTab` render (line 145 area)

**Interfaces:**
- Consumes: `canPublishPlan` / `canArchivePlan` (Task 5), `PlanLifecycleModal` (Task 7), `PlanEditor` with `plan: null` (Task 6), `listPlansForPlatform` (Task 5).
- Produces: `PlansTab` gains a required `archivedPlans: Plan[]` prop. `plans` stays active-only everywhere else in the screen (`PlatformOverview`'s donut colour indexing, `ShopsTab`, `SettingsTab`, `ShopDrawer`, `listPlatformShops` all keep today's input set).

- [ ] **Step 1: Split the fetch in `src/app/platform/index.tsx`**

In the import at line 33, replace `listAllPlans` with `listPlansForPlatform`:

```ts
import { listPlansForPlatform, type Plan } from '@/lib/subscriptions';
```

Add state beside the existing `plans` state:

```ts
  const [archivedPlans, setArchivedPlans] = useState<Plan[]>([]);
```

In `reload`, replace the plans line and the two set calls:

```ts
    const [planRows, settingsRow] = await Promise.all([listPlansForPlatform(), getPlatformSettings()]);
    // Active only, everywhere but the Plans tab's archived strip: the overview
    // donut indexes colours by array position, the retire/fallback pickers and
    // set_plan must never offer an archived plan, and listPlatformShops
    // resolves successors -- which are never archived (archive_plan refuses a
    // referenced plan). Today's behaviour, unchanged, with the archived rows
    // carried separately.
    const activePlans = planRows.filter((p) => p.active);
```

then use `activePlans` where `planRows` was used (`listPlatformShops(activePlans, ...)`, `setPlans(activePlans)`), and add:

```ts
    setArchivedPlans(planRows.filter((p) => !p.active));
```

In the `PlansTab` render, add the prop:

```tsx
      archivedPlans={archivedPlans}
```

- [ ] **Step 2: Extend `PlansTab`'s imports, props and state**

In `src/components/platform/plans-tab.tsx`:

Imports — add `Pressable` to the `react-native` import, `PlanLifecycleModal` and the predicates, and `BENTO_RADIUS`:

```tsx
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { PlanLifecycleModal } from '@/components/platform/plan-lifecycle-modal';
import { canArchivePlan, canPublishPlan } from '@/lib/plan-lifecycle';
```

and change the theme import line to:

```tsx
import { BENTO_RADIUS, BENTO_RADIUS_TILE, Colors } from '@/constants/theme';
```

Props — add to the component signature:

```tsx
  archivedPlans,
```
```tsx
  archivedPlans: Plan[];
```

State — beside `editing` / `retiring` (line 49):

```tsx
  const [creating, setCreating] = useState(false);
  const [lifecycle, setLifecycle] = useState<{ mode: 'publish' | 'archive' | 'restore'; planKey: string } | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const lifecyclePlan = lifecycle
    ? ([...plans, ...archivedPlans].find((p) => p.key === lifecycle.planKey) ?? null)
    : null;
```

- [ ] **Step 3: Count the ghost cell in the span math**

Replace the `span` computation (line 59) with:

```tsx
  // The span that leaves no orphan on the last row -- counting the ghost
  // "new plan" cell, which takes a normal grid slot. Three plans + ghost = 4
  // slots = 2x2; four across is worse -- these cards carry twelve module
  // pills and six limit tiles, and at a quarter of the width they wrap into
  // columns of soup.
  const slots = plans.length + 1;
  const span = slots === 1 ? 12 : slots === 2 || slots === 4 ? 6 : 4;
```

- [ ] **Step 4: Lifecycle buttons on the card**

`PlanCard` gains two nullable press handlers. Add to its props (both the destructure and the type):

```tsx
  onPublish,
  onArchive,
```
```tsx
  onPublish: (() => void) | null;
  onArchive: (() => void) | null;
```

In its `headButtons` row (lines 182–193), add Publish after Edit and Archive last:

```tsx
        <View style={styles.headButtons}>
          <PlatformButton label="Edit" onPress={onEdit} />
          {/* Handlers arrive null when the matching server guard would
              reject -- the same only-offer-what-the-server-takes rule the
              Retire button below already follows. */}
          {onPublish ? <PlatformButton label="Publish" onPress={onPublish} /> : null}
          {plan.retireAt || plan.isPublic ? (
            <PlatformButton label={plan.retireAt ? 'Republish' : 'Retire'} onPress={onRetire} />
          ) : null}
          {onArchive ? <PlatformButton label="Archive" onPress={onArchive} /> : null}
        </View>
```

In the grid `map` (line 64), the JSX arrow becomes a block so the stored count is computed once, and the new props are wired through the predicates:

```tsx
        {plans.map((plan, i) => {
          // Stored, not effective: this card is about the plan RECORD --
          // how many subscriptions still point here and how much money it
          // brings in -- not about who is currently enforced under it.
          // Keyed off effective plan, a retired tier's card would read "0
          // stores" forever, which is exactly wrong for the strip below
          // that still needs to say how many are moving. It is also the
          // count archive_plan checks, which is what lets canArchivePlan
          // mirror the server guard exactly.
          const storedShopsOn = shops.filter((s) => s.storedPlanKey === plan.key).length;
          return (
            <BentoCell key={plan.id} span={span}>
              <PlanCard
                plan={plan}
                accent={planColor(plan.key, i)}
                shopsOn={storedShopsOn}
                revenue={plan.priceCents * shops.filter((s) => s.storedPlanKey === plan.key && s.status === 'active').length}
                successorName={plans.find((p) => p.key === plan.successorPlanKey)?.name ?? null}
                onEdit={() => setEditing(plan.key)}
                onRetire={() => setRetiring(plan.key)}
                onPublish={canPublishPlan(plan) ? () => setLifecycle({ mode: 'publish', planKey: plan.key }) : null}
                onArchive={
                  canArchivePlan(plan, { storedShopsOn, postTrialPlanKey, plans })
                    ? () => setLifecycle({ mode: 'archive', planKey: plan.key })
                    : null
                }
              />
            </BentoCell>
          );
        })}
```

- [ ] **Step 5: The ghost cell**

Still inside `BentoGrid`, immediately after the `plans.map` block:

```tsx
        <BentoCell span={span}>
          <Pressable onPress={() => setCreating(true)} style={styles.ghost}>
            <Text style={styles.ghostPlus}>＋</Text>
            <Text style={styles.ghostTitle}>New plan</Text>
            <Text style={styles.ghostHint}>Starts hidden — publish it when it&apos;s ready</Text>
          </Pressable>
        </BentoCell>
```

- [ ] **Step 6: The archived strip**

After the `Caveat` block (line 88) closes, add:

```tsx
      {/* The way back through the active=false door. Rows offer Restore and
          nothing else -- no Edit, which is what keeps updated_at an honest
          "archived" date. */}
      {archivedPlans.length > 0 ? (
        <Card variant="bento" style={styles.archStrip}>
          <Pressable onPress={() => setShowArchived((v) => !v)} style={styles.archHead}>
            <Text style={styles.archCaret}>{showArchived ? '▾' : '▸'}</Text>
            <Text style={styles.archTitle}>Archived · {archivedPlans.length}</Text>
          </Pressable>
          {showArchived
            ? archivedPlans.map((p) => (
                <View key={p.id} style={styles.archRow}>
                  <View style={styles.archInfo}>
                    <Text style={styles.archName} numberOfLines={1}>
                      {p.name} <Text style={styles.archKey}>{p.key}</Text>
                    </Text>
                    <Text style={styles.archMeta} numberOfLines={1}>
                      {p.priceCents === 0 ? '$0' : `${formatCents(p.priceCents)}/${p.billingInterval ?? 'month'}`}
                      {' · archived '}
                      {new Date(p.updatedAt).toLocaleDateString()}
                      {p.successorPlanKey
                        ? ` · was retired into ${plans.find((a) => a.key === p.successorPlanKey)?.name ?? p.successorPlanKey}`
                        : ''}
                    </Text>
                  </View>
                  <PlatformButton label="Restore" onPress={() => setLifecycle({ mode: 'restore', planKey: p.key })} />
                </View>
              ))
            : null}
        </Card>
      ) : null}
```

- [ ] **Step 7: The two new modals**

After the `retiringPlan` modal block (line 125) closes, add:

```tsx
      {creating ? (
        <PlatformModal title="New plan" compact={compact} onClose={() => setCreating(false)}>
          <PlanEditor plan={null} shopsOn={0} shops={shops} onClose={() => setCreating(false)} onDone={onDone} />
        </PlatformModal>
      ) : null}

      {lifecycle && lifecyclePlan ? (
        <PlatformModal
          title={`${{ publish: 'Publish', archive: 'Archive', restore: 'Restore' }[lifecycle.mode]} ${lifecyclePlan.name}`}
          compact={compact}
          onClose={() => setLifecycle(null)}
        >
          <PlanLifecycleModal
            mode={lifecycle.mode}
            plan={lifecyclePlan}
            onClose={() => setLifecycle(null)}
            onDone={onDone}
          />
        </PlatformModal>
      ) : null}
```

- [ ] **Step 8: The new styles**

Add to the `StyleSheet.create` block:

```tsx
  // Deliberately not a Card: the dashed outline says "a slot, not a tier",
  // which is the one job edge decoration has on this grid.
  ghost: { flex: 1, borderWidth: 1.5, borderStyle: 'dashed', borderColor: theme.bentoLine, borderRadius: BENTO_RADIUS, alignItems: 'center', justifyContent: 'center', gap: 6, padding: 26, minHeight: 150 },
  ghostPlus: { fontSize: 22, fontWeight: '800', color: theme.bentoMuted },
  ghostTitle: { fontSize: 12.5, fontWeight: '800', color: theme.bentoInk2 },
  ghostHint: { fontSize: 10.5, color: theme.bentoMuted2, textAlign: 'center', maxWidth: 200 },

  archStrip: { marginTop: 14, paddingVertical: 6, paddingHorizontal: 16 },
  archHead: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 10 },
  archCaret: { fontSize: 9, color: theme.bentoMuted2 },
  archTitle: { fontSize: 11, fontWeight: '800', letterSpacing: 0.6, color: theme.bentoMuted2, textTransform: 'uppercase' },
  archRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, paddingVertical: 11, borderTopWidth: 1, borderTopColor: theme.bentoLine },
  archInfo: { flexShrink: 1 },
  archName: { fontSize: 13, fontWeight: '700', color: theme.bentoInk },
  archKey: { fontSize: 11, fontWeight: '400', color: theme.bentoMuted },
  archMeta: { fontSize: 10.5, color: theme.bentoMuted, marginTop: 1 },
```

- [ ] **Step 9: Typecheck, run the suite, and commit**

Run: `npx tsc --noEmit && npx jest`
Expected: both clean.

```bash
git add src/components/platform/plans-tab.tsx src/app/platform/index.tsx
git commit -m "feat(platform): Plans tab — ghost create cell, publish/archive controls, archived strip"
```

---

### Task 9: Full verification sweep

**Files:** none new.

- [ ] **Step 1: Full Jest suite and typecheck**

Run: `npx jest && npx tsc --noEmit`
Expected: all suites pass, tsc clean.

- [ ] **Step 2: Lint**

Run: `npm run lint`
Expected: no new warnings in the touched files.

- [ ] **Step 3: SQL verification against a fresh DB**

With local Supabase running:

```bash
supabase db reset && \
  psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -f supabase/tests/verify-platform-portal.sql && \
  psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -f supabase/tests/verify-entitlements.sql
```

Expected: `ALL CHECKS PASSED` from both, `CLEAN: no rows left behind`.

- [ ] **Step 4: See it in the running app**

Use the `testing-kaiibi` skill (web) against the platform portal's Plans tab:

- the ghost cell renders at the end of the grid; three plans + ghost lay out 2×2
- "New plan" → create sheet: key field gates save on `Standard!`-shaped input; creating `starter` at $9 lands a card with the "Not public" chip and a Publish button
- Publish confirm names the price and module/limit counts; after publishing, the chip and button are gone
- Trial's card shows no Publish and no Archive button
- a retired plan with 0 stored stores shows Archive; archiving moves it into the "Archived · N" strip; Restore brings it back with its retired chip intact

Expected: all five hold. Screenshot the tab for the record.

- [ ] **Step 5: Commit anything the sweep shook out, then stop**

```bash
git status
```

Expected: clean tree (or only deliberate fixes from Step 4, committed with their own messages). Do not push — shared branch.

## Self-review notes

- Spec coverage: `upsert_plan` create mode → Task 1; `publish_plan` → Task 2; `archive_plan`/`restore_plan` → Task 3; `set_plan`/`approve_plan_change` hardening → Task 4; C1 (`Plan.active`, `listPlansForPlatform`) → Task 5; C2 (editor) → Task 6; C3 (tab: ghost, buttons, strip, pickers-stay-active) → Tasks 7–8; "store-facing untouched" → Task 5 leaves `listPlans`/`listAllPlans` alone and Task 8 Step 1 keeps every other consumer on active-only rows; proving → Tasks 3, 5, 9.
- The spec's Jest item "plans-tab span math counts the ghost cell" is covered by inspection in Task 8 Step 3 plus Task 9 Step 4's layout check rather than a component test — this repo has no component-test harness, and the predicates (the part that can silently drift from the server) are the part under Jest.
- Type consistency: `canPublishPlan(plan)` / `canArchivePlan(plan, { storedShopsOn, postTrialPlanKey, plans })` match between Tasks 5 and 8; `PlanLifecycleModal({ mode, plan, onClose, onDone })` matches between Tasks 7 and 8; `create?: boolean` body flag matches Tasks 1 and 6; `updatedAt` matches Tasks 5 and 8.
