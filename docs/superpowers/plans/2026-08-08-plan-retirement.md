# Plan Retirement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an operator withdraw a plan from sale from the portal — hiding it from the chooser immediately, warning the stores on it, and moving them to a named successor after 30 days — without a deploy.

**Architecture:** Two columns on `plans` (`retire_at`, `successor_plan_key`) plus one extra hop in `shop_effective_plan()`. Nothing is ever bulk-updated and there is no scheduled job: a retired-past-date plan resolves to its successor at read time, so clearing `retire_at` restores every store instantly. The edge function enforces the invariants that keep the hop exactly one deep.

**Tech Stack:** Postgres (Supabase migrations, `security definer` SQL functions), Deno edge function (`supabase/functions/platform-admin`), React Native / Expo Router with TypeScript, Jest, `psql`-run SQL verification scripts.

**Spec:** [docs/superpowers/specs/2026-08-08-plan-retirement-design.md](../specs/2026-08-08-plan-retirement-design.md)
**Mockup:** [docs/design/plan-retirement-mockup.html](../../design/plan-retirement-mockup.html)

## Global Constraints

- **Never hardcode a hex in a screen.** Every colour is a token from `src/constants/theme.ts`. Amber status is `theme.bentoWarn` (`#b07206`).
- **A status colour always carries a glyph or sign.** Colour alone is never the signal — deutan viewers.
- **The platform portal is bento.** Cards are `Card variant="bento"` (radius 26) or `BentoCard`. Every platform file pins `const theme = Colors.light;` — there is no dark mode.
- **`src/components/settings/` is cream, NOT bento.** It reads `background` / `surface` / `border` and uses `Section` / `Row` / `Badge` / `Btn` from `settings-primitives`. Do not import bento tokens there.
- **Every `platform-admin` action requires a `reason`.** It is checked centrally at `index.ts:95` before any case runs — do not re-check it per action.
- **Every `platform-admin` mutation calls `audit(...)`.** An unlogged change is worse than a refused one.
- **Retirement never touches `plans.active` or any `shop_subscriptions` row.** `active` remains the hard "this plan is gone" switch.
- **`Caveat tone="wrong"` must have an `action`.** A `wrong` caveat with nothing to do trains people to ignore the whole family. Use `tone="context"` when there is nothing to do.
- **Migration filenames are `YYYYMMDDHHMMSS_snake_case.sql`** and must sort after `20260823000000_owner_is_a_team_member.sql`.
- **Run SQL tests against the LOCAL database only** (`postgresql://postgres:postgres@127.0.0.1:54322/postgres`).

## Known-open decision (does not block any task below)

The spec assumes the new fallback floor when Free is retired is a smaller free tier called **Starter**, which does not exist yet. Tasks 3 and 8 make the *replacement fallback* a required input when retiring the plan named in `post_trial_plan_key`; none of them hardcode `starter`. Whatever the floor turns out to be, it is data.

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `supabase/migrations/20260824000000_plan_retirement.sql` | Create: the two columns + constraints | 1 |
| `supabase/migrations/20260824000100_resolve_retired_plans.sql` | Create: `shop_effective_plan()` gains the successor hop | 2 |
| `supabase/tests/verify-entitlements.sql` | Modify: prove the hop, both directions, and that status is unchanged | 2 |
| `supabase/functions/platform-admin/index.ts` | Modify: `retire_plan` / `republish_plan`; guard `approve_plan_change`; clamp `record_payment` | 3, 4, 11 |
| `supabase/tests/verify-platform-portal.sql` | Modify: prove the rejections | 3, 4 |
| `src/lib/subscriptions.ts` | Modify: two fields on `Plan` + `mapPlanRow` | 5 |
| `src/lib/platform.ts` | Modify: `listPlatformShops()` resolves through the successor; new `getPlatformSettings()` — nothing reads `platform_settings` client-side today | 6, 8 |
| `src/app/platform/index.tsx` | Modify: fetch plans before shops, load settings, feed the new props | 6, 8 |
| `src/lib/__tests__/platform-retirement.test.ts` | Create: the resolution mirror, unit-tested | 6 |
| `src/components/platform/plan-retire-modal.tsx` | Create: the retire sheet, its own file — `plans-tab.tsx` stays a card renderer | 8 |
| `src/components/platform/plans-tab.tsx` | Modify: Retire/Republish control, countdown chip, successor strip | 7, 8 |
| `src/components/platform/shops-tab.tsx` | Modify: the "Retiring plan" filter segment | 9 |
| `src/components/settings/panels/billing-panel.tsx` | Modify: the shop's warning banner (cream) | 10 |
| `src/components/platform/shop-drawer.tsx` | Modify: `addMonths` follows `billing_interval` | 12 |

---

### Task 1: The two columns

**Files:**
- Create: `supabase/migrations/20260824000000_plan_retirement.sql`

**Interfaces:**
- Consumes: nothing.
- Produces: `public.plans.retire_at timestamptz`, `public.plans.successor_plan_key text`. Both null on every existing row.

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/20260824000000_plan_retirement.sql`:

```sql
-- Withdrawing a tier from sale, gracefully.
--
-- 20260818000000 put plans in a table so "pricing and packaging change from the
-- admin portal without a deploy". Withdrawing a tier was the exception: it took
-- a code edit (0be1bae removed Free from landing-plans.tsx and two i18n files),
-- and that edit only changed the marketing page -- the tier stayed in
-- listPlans() and was still offered inside the app.
--
-- Retirement is deliberately NOT `active = false`. That column stays the hard
-- "this plan is gone" switch, protected by the on delete restrict on
-- shop_subscriptions.plan_id. This is the graceful path that runs first:
-- hidden from the chooser now, stores moved on a date they were told about.

alter table public.plans
  -- The date stores MOVE, not the date the plan was hidden. Hiding is
  -- is_public = false and happens the moment the operator acts.
  add column retire_at          timestamptz,
  -- Where they land. References key rather than id because key is the stable
  -- identifier everything else in this schema hangs off (see
  -- platform_settings.post_trial_plan_key), and because the FK then guarantees
  -- the successor exists without the resolver having to check.
  add column successor_plan_key text references public.plans(key);

alter table public.plans
  -- A retirement with nowhere to go would strand every store on it at the
  -- moment the date passed.
  add constraint plans_retire_needs_successor
    check (retire_at is null or successor_plan_key is not null),
  -- Self-succession resolves to itself forever: the plan would read as retired
  -- and never actually move anyone.
  add constraint plans_successor_not_self
    check (successor_plan_key is distinct from key);
```

- [ ] **Step 2: Apply it and confirm the chain still builds from empty**

Run:
```bash
supabase db reset
```
Expected: every migration applies with no error. This is the check that matters — it proves the whole chain still works against an empty database, which incremental pushes never verify.

- [ ] **Step 3: Confirm the columns exist and are null everywhere**

Run:
```bash
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -c \
  "select key, retire_at, successor_plan_key from public.plans order by sort_order;"
```
Expected: four rows (`trial`, `free`, `standard`, `pro`), `retire_at` and `successor_plan_key` both null on all of them.

- [ ] **Step 4: Confirm the constraints bite**

Run:
```bash
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -c \
  "update public.plans set retire_at = now() where key = 'free';"
```
Expected: `ERROR: new row for relation "plans" violates check constraint "plans_retire_needs_successor"`

Run:
```bash
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -c \
  "update public.plans set successor_plan_key = 'free' where key = 'free';"
```
Expected: `ERROR: new row for relation "plans" violates check constraint "plans_successor_not_self"`

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260824000000_plan_retirement.sql
git commit -m "feat: give plans a retirement date and a successor"
```

---

### Task 2: The resolver hop

**Files:**
- Create: `supabase/migrations/20260824000100_resolve_retired_plans.sql`
- Modify: `supabase/tests/verify-entitlements.sql` (append a new section before the final rollback)

**Interfaces:**
- Consumes: `plans.retire_at`, `plans.successor_plan_key` (Task 1).
- Produces: `shop_effective_plan(p_shop_id uuid) returns public.plans` — same signature, now following one successor hop. `shop_effective_status()` is unchanged and must stay unchanged.

- [ ] **Step 1: Write the failing test**

Open `supabase/tests/verify-entitlements.sql`. Find the final section and the `raise exception 'rollback'` that ends the `do` block. Insert this section immediately **before** that rollback, and add `v_std_id uuid;` to the `declare` list at the top:

```sql
  -- ------------------------------------------------- 9. retiring a plan
  -- The whole retirement design rests on this function, so it is proved here
  -- rather than trusted. Note what is NOT asserted to change: status. A store
  -- on a retired plan is not lapsed and must never read as such.
  select id into v_std_id from public.plans where key = 'standard';

  update public.shop_subscriptions
  set plan_id = v_free_id,
      trial_ends_at = now() - interval '100 days',
      grace_until   = now() - interval '93 days',
      current_period_end = null
  where shop_id = v_shop_id;

  -- Retirement in the FUTURE changes nothing at all.
  update public.plans
  set retire_at = now() + interval '30 days', successor_plan_key = 'standard'
  where key = 'free';

  if (public.shop_effective_plan(v_shop_id)).key <> 'free' then
    raise exception 'FAIL: a plan retiring in 30 days already moved its stores (got %)',
      (public.shop_effective_plan(v_shop_id)).key;
  end if;
  if public.shop_has_module(v_shop_id, 'accounting') then
    raise exception 'FAIL: a store got the successor''s modules before the date';
  end if;

  -- Past the date, the successor applies.
  update public.plans set retire_at = now() - interval '1 day' where key = 'free';

  if (public.shop_effective_plan(v_shop_id)).key <> 'standard' then
    raise exception 'FAIL: a retired plan did not resolve to its successor (got %)',
      (public.shop_effective_plan(v_shop_id)).key;
  end if;
  if not public.shop_has_module(v_shop_id, 'accounting') then
    raise exception 'FAIL: the successor''s modules did not apply after the date';
  end if;

  -- Status is untouched by retirement. This is the assertion most likely to
  -- catch a well-meaning change to shop_effective_status().
  if public.shop_effective_status(v_shop_id) <> 'expired' then
    raise exception 'FAIL: retirement changed the store''s status to %',
      public.shop_effective_status(v_shop_id);
  end if;

  -- Republishing restores everyone, because nothing was destroyed.
  update public.plans set retire_at = null, successor_plan_key = null where key = 'free';

  if (public.shop_effective_plan(v_shop_id)).key <> 'free' then
    raise exception 'FAIL: republishing did not restore the original plan (got %)',
      (public.shop_effective_plan(v_shop_id)).key;
  end if;

  -- The subscription row was never rewritten -- that is the entire point.
  if (select plan_id from public.shop_subscriptions where shop_id = v_shop_id) <> v_free_id then
    raise exception 'FAIL: retirement rewrote plan_id instead of resolving at read time';
  end if;
```

- [ ] **Step 2: Run it to make sure it fails**

Run:
```bash
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
  -f supabase/tests/verify-entitlements.sql
```
Expected: FAIL — `FAIL: a retired plan did not resolve to its successor (got free)`. The resolver does not look at the new columns yet.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/20260824000100_resolve_retired_plans.sql`:

```sql
-- shop_effective_plan() follows a retired plan to its successor.
--
-- The alternative was a scheduled job that rewrites plan_id on every affected
-- subscription when the date lands. Rejected for three reasons: there is no
-- pg_cron in this project, 20260818000200's own header argues against "a
-- nightly job whose failure leaves a lapsed shop reading as active", and a
-- bulk rewrite cannot be undone -- once 218 rows have moved, republishing
-- brings nobody back. Resolving at read time means clearing retire_at restores
-- every store instantly, because nothing was destroyed.
--
-- ONE HOP, NOT A CHAIN. A recursive resolve would turn an operator's mistake
-- into an infinite loop inside a function called on every gated write. The
-- edge function refuses to retire into a plan that is itself retiring, and
-- when retiring B it re-points anything whose successor was B onto B's own
-- successor -- so chains are one hop long by construction and this never has
-- to walk one.
--
-- shop_effective_status() is deliberately NOT touched. Retirement changes
-- which plan applies, never what status a store is in: a store on a retired
-- plan has not lapsed and must not read as though it has.

create or replace function public.shop_effective_plan(p_shop_id uuid)
returns public.plans
language sql security definer stable set search_path = public as $$
  with base as (
    select case
      when public.shop_effective_status(p_shop_id) in ('trialing', 'active', 'grace')
        then (select pl.key from public.shop_subscriptions s
                join public.plans pl on pl.id = s.plan_id
               where s.shop_id = p_shop_id)
      else (select ps.post_trial_plan_key from public.platform_settings ps where ps.id)
    end as key
  ),
  hopped as (
    select coalesce(
      (select r.successor_plan_key from public.plans r
        where r.key = (select key from base)
          and r.retire_at is not null
          and r.retire_at <= now()),
      (select key from base)
    ) as key
  )
  select p.* from public.plans p where p.key = (select key from hopped);
$$;
```

- [ ] **Step 4: Apply and run the test to verify it passes**

Run:
```bash
supabase db reset
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
  -f supabase/tests/verify-entitlements.sql
```
Expected: `ALL CHECKS PASSED`

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260824000100_resolve_retired_plans.sql supabase/tests/verify-entitlements.sql
git commit -m "feat: resolve a retired plan to its successor at read time"
```

---

### Task 3: `retire_plan` and `republish_plan`

**Files:**
- Modify: `supabase/functions/platform-admin/index.ts` — the `Action` union at line 15, the `RequestBody` type at line 30, and a new case after `upsert_plan` (line 324)
- Modify: `supabase/tests/verify-platform-portal.sql`

**Interfaces:**
- Consumes: the columns from Task 1, the resolver from Task 2.
- Produces: two actions callable via `callPlatformAdmin`:
  - `retire_plan` — `{ planKey: string, successorPlanKey: string, retireAt?: string, postTrialPlanKey?: string }`
  - `republish_plan` — `{ planKey: string }`
  Both return `{ plan }`. Error codes: `unknown` (400) for every validation failure, matching the existing style.

- [ ] **Step 1: Add the actions to the type unions**

In `supabase/functions/platform-admin/index.ts`, extend the `Action` union (line 15) — add after `'upsert_plan'`:

```ts
  | 'retire_plan'
  | 'republish_plan'
```

And add to `RequestBody` (after the `plan?` field at line 52):

```ts
  // retire_plan / republish_plan. successorPlanKey is where the stores on this
  // plan land when retireAt passes; postTrialPlanKey is only used when the plan
  // being retired is the platform-wide fallback (see the case below).
  successorPlanKey?: string;
  retireAt?: string;
  postTrialPlanKey?: string;
```

- [ ] **Step 2: Write the failing test**

Append to `supabase/tests/verify-platform-portal.sql`, before its final rollback. These assert the *database-side* invariants the edge function relies on; the edge-function rejections themselves are asserted by the checks in Step 4.

```sql
  -- ------------------------------------ retirement invariants the guards rest on
  -- The FK is what lets the resolver skip an existence check on the successor.
  begin
    update public.plans
    set retire_at = now() + interval '30 days', successor_plan_key = 'no_such_plan'
    where key = 'free';
    raise exception 'FAIL: a successor that does not exist was accepted';
  exception when foreign_key_violation then
    null;
  end;

  -- One hop is only safe if nothing can point at itself.
  begin
    update public.plans set successor_plan_key = 'free' where key = 'free';
    raise exception 'FAIL: a plan was allowed to succeed itself';
  exception when check_violation then
    null;
  end;
```

- [ ] **Step 3: Run it to verify it passes already**

Run:
```bash
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
  -f supabase/tests/verify-platform-portal.sql
```
Expected: `ALL CHECKS PASSED`. These invariants come from Task 1 — this step confirms the guards below can rely on them rather than re-checking.

- [ ] **Step 4: Write the two cases**

In `supabase/functions/platform-admin/index.ts`, insert immediately after the `upsert_plan` case closes (after line 324, before `case 'set_platform_settings'`):

```ts
      case 'retire_plan': {
        if (!body.planKey || !body.successorPlanKey) {
          return errorResponse(400, 'unknown', 'planKey and successorPlanKey are required.');
        }
        if (body.planKey === body.successorPlanKey) {
          return errorResponse(400, 'unknown', 'A plan cannot succeed itself.');
        }

        const { data: plan } = await adminClient.from('plans').select('*').eq('key', body.planKey).maybeSingle();
        if (!plan) return errorResponse(400, 'unknown', 'No such plan.');

        const { data: successor } = await adminClient
          .from('plans').select('*').eq('key', body.successorPlanKey).maybeSingle();
        if (!successor) return errorResponse(400, 'unknown', 'No such successor plan.');
        if (!successor.active) {
          return errorResponse(400, 'unknown', 'That successor is deactivated — stores cannot be moved onto it.');
        }
        // `trial` is assigned by the signup trigger and can never be chosen, so
        // it can never be somewhere stores are moved TO.
        if (!successor.is_public) {
          return errorResponse(400, 'unknown', 'That successor is not offered to stores, so nobody can be moved onto it.');
        }
        // Keeps every chain exactly one hop long, which is what lets
        // shop_effective_plan() resolve without recursing.
        if (successor.retire_at) {
          return errorResponse(400, 'unknown', 'That successor is itself being retired. Pick a plan that is staying.');
        }

        // Free is reached by falling THROUGH post_trial_plan_key, not by being
        // on it: shop_effective_status is dates-only, so an expired store
        // resolves to the fallback plan. Retiring the fallback without naming a
        // new one would hand every lapsed store on the platform the successor's
        // entitlements for nothing.
        const { data: settings } = await adminClient
          .from('platform_settings').select('post_trial_plan_key').eq('id', true).maybeSingle();
        const isFallback = settings?.post_trial_plan_key === body.planKey;
        if (isFallback && !body.postTrialPlanKey) {
          return errorResponse(
            400,
            'unknown',
            'This plan is where lapsed stores land. Choose a new fallback plan before retiring it.'
          );
        }
        if (body.postTrialPlanKey) {
          const { data: fallback } = await adminClient
            .from('plans').select('key, active, retire_at').eq('key', body.postTrialPlanKey).maybeSingle();
          if (!fallback) return errorResponse(400, 'unknown', 'No such fallback plan.');
          if (!fallback.active || fallback.retire_at) {
            return errorResponse(400, 'unknown', 'The fallback plan must be one that is staying.');
          }
        }

        // 30 days: long enough for a store to be told, decide, and be moved by
        // hand if they ask. The portal offers no other value today; the field
        // exists so a longer sunset does not need a deploy.
        const retireAt = body.retireAt ?? new Date(Date.now() + 30 * 86_400_000).toISOString();

        const { data: after, error } = await adminClient
          .from('plans')
          .update({
            is_public: false,
            retire_at: retireAt,
            successor_plan_key: body.successorPlanKey,
            updated_at: new Date().toISOString(),
          })
          .eq('key', body.planKey)
          .select('*')
          .single();
        if (error) return errorResponse(500, 'unknown', error.message);

        // Anything that pointed at this plan now points past it, so no chain is
        // ever two hops long. Without this, retiring A->B and later B->C would
        // leave A's stores landing on a plan that is itself gone.
        const { error: repointError } = await adminClient
          .from('plans')
          .update({ successor_plan_key: body.successorPlanKey, updated_at: new Date().toISOString() })
          .eq('successor_plan_key', body.planKey);
        if (repointError) return errorResponse(500, 'unknown', repointError.message);

        let settingsAfter = settings;
        if (body.postTrialPlanKey) {
          const { data: updatedSettings, error: settingsError } = await adminClient
            .from('platform_settings')
            .update({ post_trial_plan_key: body.postTrialPlanKey, updated_at: new Date().toISOString() })
            .eq('id', true)
            .select('*')
            .single();
          if (settingsError) return errorResponse(500, 'unknown', settingsError.message);
          settingsAfter = updatedSettings;
        }

        await audit('retire_plan', null, { plan, settings }, { plan: after, settings: settingsAfter });
        return ok({ plan: after });
      }

      case 'republish_plan': {
        if (!body.planKey) return errorResponse(400, 'unknown', 'planKey is required.');
        const { data: before } = await adminClient.from('plans').select('*').eq('key', body.planKey).maybeSingle();
        if (!before) return errorResponse(400, 'unknown', 'No such plan.');

        const { data: after, error } = await adminClient
          .from('plans')
          .update({
            is_public: true,
            retire_at: null,
            successor_plan_key: null,
            updated_at: new Date().toISOString(),
          })
          .eq('key', body.planKey)
          .select('*')
          .single();
        if (error) return errorResponse(500, 'unknown', error.message);

        // Deliberately does NOT restore post_trial_plan_key. That is a separate
        // deliberate setting, and silently moving the platform's fallback back
        // would relocate lapsed stores nobody asked to move. The portal says so.
        await audit('republish_plan', null, before, after);
        return ok({ plan: after });
      }
```

- [ ] **Step 5: Deploy the function and check the guards by hand**

Run:
```bash
supabase functions deploy platform-admin
```
Expected: deploys with no TypeScript error.

Then, signed in as a platform admin in the portal (or via `curl` with an operator JWT), confirm each rejection message appears for: a nonexistent successor, `trial` as successor, a successor that is itself retiring, and retiring `free` (the current `post_trial_plan_key`) with no replacement fallback.

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/platform-admin/index.ts supabase/tests/verify-platform-portal.sql
git commit -m "feat: retire and republish a plan from the portal"
```

---

### Task 4: Refuse to approve a move onto a retiring plan

**Files:**
- Modify: `supabase/functions/platform-admin/index.ts` — the `approve_plan_change` case at line 340

**Interfaces:**
- Consumes: `plans.retire_at` (Task 1).
- Produces: `approve_plan_change` returns HTTP 409 with error code `plan_retiring` when the requested plan is being retired.

- [ ] **Step 1: Understand the hole before closing it**

The insert policy at `supabase/migrations/20260818000700_plan_change_requests.sql:52-57` checks the caller's permission, that `status = 'pending'`, and that `requested_by = auth.uid()` — **it does not check `is_public`.** So pending requests to move *onto* a plan already exist at the moment it is retired, and without this guard `approve_plan_change` would move that store onto the plan being shut down.

- [ ] **Step 2: Add the guard**

In `supabase/functions/platform-admin/index.ts`, in the shared `approve_plan_change` / `decline_plan_change` case, find the existing already-decided guard:

```ts
        if (request.status !== 'pending') {
          return errorResponse(409, 'already_decided', `That request was already ${request.status}.`);
        }
```

Insert immediately after it:

```ts
        // Same class of problem as already_decided: a decision made against
        // state that has since changed. plan_change_requests' insert policy
        // never checked is_public, so requests to move ONTO a plan survive its
        // retirement -- and approving one would move a store onto the very plan
        // we are shutting down. Declining still works; only approval is refused.
        if (action === 'approve_plan_change') {
          const { data: requestedPlan } = await adminClient
            .from('plans').select('name, retire_at').eq('id', request.requested_plan_id).maybeSingle();
          if (requestedPlan?.retire_at) {
            return errorResponse(
              409,
              'plan_retiring',
              `${requestedPlan.name} is being retired, so stores cannot be moved onto it. Decline this and move them to its successor instead.`
            );
          }
        }
```

- [ ] **Step 3: Deploy and verify by hand**

Run:
```bash
supabase functions deploy platform-admin
```

Then: raise a plan change request for a plan, retire that plan, and try to approve the request in the portal's Requests tab.
Expected: the approval is refused with "… is being retired, so stores cannot be moved onto it." Declining the same request still succeeds.

- [ ] **Step 4: Commit**

```bash
git add supabase/functions/platform-admin/index.ts
git commit -m "fix: refuse to approve a move onto a plan being retired"
```

---

### Task 5: The two fields on `Plan`

**Files:**
- Modify: `src/lib/subscriptions.ts:13-44`

**Interfaces:**
- Consumes: the columns from Task 1.
- Produces: `Plan.retireAt: string | null` and `Plan.successorPlanKey: string | null`. Every later task reads these names.

- [ ] **Step 1: Add the fields to the type**

In `src/lib/subscriptions.ts`, add to the `Plan` type after `isPublic`:

```ts
  // When the stores still on this plan move to `successorPlanKey`. Null means
  // the plan is not being retired. Setting it does NOT hide the plan --
  // `isPublic` does that, and the two are set together by `retire_plan`.
  retireAt: string | null;
  successorPlanKey: string | null;
```

And to `mapPlanRow`, after `isPublic: row.is_public,`:

```ts
    retireAt: row.retire_at ?? null,
    successorPlanKey: row.successor_plan_key ?? null,
```

- [ ] **Step 2: Verify nothing else needs changing**

`listPlans()` needs no change: its existing `.eq('is_public', true)` is what makes a retired plan vanish from the shop's chooser on day one. `listAllPlans()` needs no change either — the portal wants every plan, retiring or not.

Run:
```bash
npx tsc --noEmit
```
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/lib/subscriptions.ts
git commit -m "feat: carry a plan's retirement date to the client"
```

---

### Task 6: Make the portal tell the truth about retired plans

**Files:**
- Modify: `src/lib/platform.ts` — `listPlatformShops()` at lines 127-171, and `PlatformShopRow` at lines 9-27
- Create: `src/lib/__tests__/platform-retirement.test.ts`

**Interfaces:**
- Consumes: `Plan.retireAt`, `Plan.successorPlanKey` (Task 5).
- Produces:
  - `export function resolveRetiredPlan<T extends { key: string; retireAt: string | null; successorPlanKey: string | null }>(planKey: string, plans: T[], now?: number): string` — returns the key that actually applies, following at most one hop.
  - `PlatformShopRow.retiringTo: string | null` — the successor's plan name when this store's plan is retiring, else null.
  - `listPlatformShops(plans: Plan[])` — **signature change**: it now takes the plan list. Its caller is `src/app/platform/index.tsx:91`, which already fetches plans via `listAllPlans()` in the same `Promise.all`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/__tests__/platform-retirement.test.ts`:

```ts
import { resolveRetiredPlan } from '@/lib/platform';

// The client-side mirror of shop_effective_plan()'s successor hop. The server
// stays the authority for enforcement; this exists so the portal's own list can
// show the plan that actually applies without one RPC per row. If it drifts
// from 20260824000100_resolve_retired_plans.sql, the operator sees the dead
// plan's limits while the server enforces the successor's.

const PAST = '2020-01-01T00:00:00.000Z';
const FUTURE = '2999-01-01T00:00:00.000Z';

const plan = (key: string, retireAt: string | null = null, successorPlanKey: string | null = null) => ({
  key,
  retireAt,
  successorPlanKey,
});

describe('resolveRetiredPlan', () => {
  it('leaves a plan that is not retiring alone', () => {
    const plans = [plan('free'), plan('standard')];
    expect(resolveRetiredPlan('free', plans)).toBe('free');
  });

  it('leaves a plan whose retirement is still in the future alone', () => {
    const plans = [plan('free', FUTURE, 'standard'), plan('standard')];
    expect(resolveRetiredPlan('free', plans)).toBe('free');
  });

  it('follows the successor once the date has passed', () => {
    const plans = [plan('free', PAST, 'standard'), plan('standard')];
    expect(resolveRetiredPlan('free', plans)).toBe('standard');
  });

  it('follows one hop only, matching the SQL resolver', () => {
    // retire_plan re-points anything aimed at a plan it retires, so this state
    // should not occur. If it does, stopping is right: a loop here runs on
    // every row of the portal's store list.
    const plans = [plan('a', PAST, 'b'), plan('b', PAST, 'c'), plan('c')];
    expect(resolveRetiredPlan('a', plans)).toBe('b');
  });

  it('returns the original key when the successor is missing from the list', () => {
    const plans = [plan('free', PAST, 'starter')];
    expect(resolveRetiredPlan('free', plans)).toBe('free');
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run:
```bash
npx jest src/lib/__tests__/platform-retirement.test.ts
```
Expected: FAIL — `resolveRetiredPlan is not a function` / the module has no such export.

- [ ] **Step 3: Write the resolver**

In `src/lib/platform.ts`, add above `listPlatformShops`:

```ts
// The client-side twin of shop_effective_plan()'s successor hop, in the same
// spirit as deriveStatus() below: the server remains the authority for
// enforcement, and this exists so the portal's list can be sorted, filtered and
// costed without one RPC per row.
//
// One hop, matching the SQL exactly. retire_plan re-points anything aimed at a
// plan it retires, so a two-hop chain should never exist -- and if one somehow
// does, stopping beats looping in a function that runs per row.
export function resolveRetiredPlan<
  T extends { key: string; retireAt: string | null; successorPlanKey: string | null },
>(planKey: string, plans: T[], now: number = Date.now()): string {
  const current = plans.find((p) => p.key === planKey);
  if (!current?.retireAt || !current.successorPlanKey) return planKey;
  if (new Date(current.retireAt).getTime() > now) return planKey;
  // An unknown successor means this build has not seen that plan row. Falling
  // back to the original key shows something stale rather than nothing at all.
  return plans.some((p) => p.key === current.successorPlanKey) ? current.successorPlanKey : planKey;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run:
```bash
npx jest src/lib/__tests__/platform-retirement.test.ts
```
Expected: PASS, 5 tests.

- [ ] **Step 5: Use it in `listPlatformShops`**

Add to `PlatformShopRow` (after `planName`):

```ts
  // The successor's NAME when this store's plan is retiring, else null. Drives
  // the "Retiring plan" filter and the row's countdown badge.
  retiringTo: string | null;
```

Change the signature and the mapping. `listPlatformShops()` becomes:

```ts
export async function listPlatformShops(plans: Plan[]): Promise<PlatformShopRow[]> {
```

Add the import at the top of the file if not present:

```ts
import type { Plan } from '@/lib/subscriptions';
```

Then inside the final `.map(...)`, replace the `planKey`, `planName` and `limits` lines with:

```ts
      // What the store is ON versus what actually APPLIES. Past retire_at the
      // server enforces the successor's modules and limits, so showing the
      // subscription's own joined plan here would put the wrong name, the wrong
      // price in MRR, and the wrong denominators on every usage bar.
      const storedKey = sub?.plans?.key ?? 'free';
      const effectiveKey = resolveRetiredPlan(storedKey, plans);
      const effectivePlan = plans.find((p) => p.key === effectiveKey);
      const storedPlan = plans.find((p) => p.key === storedKey);
      const retiringTo =
        storedPlan?.retireAt && storedPlan.successorPlanKey
          ? (plans.find((p) => p.key === storedPlan.successorPlanKey)?.name ?? null)
          : null;

      return {
        shopId: shop.id,
        shopName: shop.name,
        ownerId: shop.owner_id,
        createdAt: shop.created_at,
        planKey: effectiveKey,
        planName: effectivePlan?.name ?? sub?.plans?.name ?? 'Free',
        retiringTo,
```

and the `limits` line to:

```ts
        limits: effectivePlan?.limits ?? sub?.plans?.limits ?? {},
```

Leave `status`, `trialEndsAt`, `currentPeriodEnd`, `manualStatus`, `usage`, `contactPhone` and `city` exactly as they are.

- [ ] **Step 6: Update the caller**

In `src/app/platform/index.tsx`, `reload()` currently fetches shops and plans in the same `Promise.all`. Plans must resolve first, so `listPlatformShops` can be told about retirements. Replace the `Promise.all` at lines 89-96 with:

```ts
    // Plans first, alone: listPlatformShops needs them to resolve a retired
    // plan to its successor, so it cannot run in the same batch.
    const planRows = await listAllPlans();
    const [shopRows, auditRows, operatorRows, requestRows, paymentRows] = await Promise.all([
      listPlatformShops(planRows),
      listAuditLog(),
      listOperators(),
      listPendingPlanRequests(),
      listSubscriptionPayments(),
    ]);
```

Every `setX(...)` call below it stays exactly as it is — `setPlans(planRows)` still works, because `planRows` is still in scope.

- [ ] **Step 7: Run the full suite**

Run:
```bash
npx tsc --noEmit && npm test
```
Expected: no type errors; all tests pass.

- [ ] **Step 8: Commit**

```bash
git add src/lib/platform.ts src/lib/__tests__/platform-retirement.test.ts src/app/platform/index.tsx
git commit -m "fix: show the plan that actually applies to a store, not the retired one"
```

---

### Task 7: The countdown on the plan card

**Files:**
- Modify: `src/components/platform/plans-tab.tsx` — `PlanCard` at lines 92-178 and `styles` at 180-214

**Interfaces:**
- Consumes: `Plan.retireAt`, `Plan.successorPlanKey` (Task 5).
- Produces: `PlanCard` accepts `successorName: string | null` and `onRetire: () => void`.

- [ ] **Step 1: Add the helper and the chip**

In `src/components/platform/plans-tab.tsx`, add above `PlanCard`:

```ts
// Whole days, rounded up: "retires in 0 days" on the morning of the last day is
// wrong in the direction that matters.
function daysUntilRetire(retireAt: string): number {
  return Math.max(0, Math.ceil((new Date(retireAt).getTime() - Date.now()) / 86_400_000));
}
```

Change the `PlanCard` signature to add two props:

```ts
function PlanCard({
  plan,
  accent,
  shopsOn,
  revenue,
  successorName,
  onEdit,
  onRetire,
}: {
  plan: Plan;
  accent: string;
  shopsOn: number;
  revenue: number;
  successorName: string | null;
  onEdit: () => void;
  onRetire: () => void;
}) {
```

Replace the `head` block (lines 110-119) with:

```tsx
      <View style={styles.head}>
        <View style={styles.nameRow}>
          <View style={[styles.dot, { backgroundColor: accent }]} />
          <Text style={styles.name} numberOfLines={1}>
            {plan.name}
          </Text>
          {/* The glyph, not just the amber: bentoWarn is a status colour and
              colour alone is never the signal. */}
          {plan.retireAt ? (
            <Chip label={`⚠ Retires in ${daysUntilRetire(plan.retireAt)} days`} />
          ) : !plan.isPublic ? (
            <Chip label="Not public" />
          ) : null}
        </View>
        <View style={styles.headButtons}>
          <PlatformButton label="Edit" onPress={onEdit} />
          <PlatformButton label={plan.retireAt ? 'Republish' : 'Retire'} onPress={onRetire} />
        </View>
      </View>
```

- [ ] **Step 2: Add the successor strip**

Immediately after the `stats` block (after line 142, before the `WHAT'S INCLUDED` subhead), insert:

```tsx
      {plan.retireAt && successorName ? (
        <View style={styles.retireStrip}>
          <Text style={styles.retireGlyph}>→</Text>
          <Text style={styles.retireText}>
            Hidden from the plan picker. On {new Date(plan.retireAt).toLocaleDateString()} the {shopsOn} store
            {shopsOn === 1 ? '' : 's'} still here move to {successorName}.
          </Text>
        </View>
      ) : null}
```

- [ ] **Step 3: Add the styles**

Add to the `StyleSheet.create` block:

```ts
  headButtons: { flexDirection: 'row', gap: 7, flexShrink: 0 },
  // The amber wash has no token: bentoWarn is the ink, and a soft tile
  // (`bentoSoft`) behind amber text reads as disabled rather than as a warning.
  // Kept local rather than invented as a token for one use.
  retireStrip: { flexDirection: 'row', alignItems: 'flex-start', gap: 9, marginTop: 14, padding: 12, backgroundColor: '#fdf4e3', borderRadius: BENTO_RADIUS_TILE },
  retireGlyph: { fontSize: 13, color: theme.bentoWarn, fontWeight: '800' },
  retireText: { flex: 1, fontSize: 11.5, lineHeight: 17, fontWeight: '700', color: theme.bentoWarn },
```

- [ ] **Step 4: Pass the new props from `PlansTab`**

In `PlansTab`, add state beside the existing `editing` state:

```ts
  const [retiring, setRetiring] = useState<string | null>(null);
```

and pass the two props in the `plans.map(...)` render:

```tsx
            <PlanCard
              plan={plan}
              accent={planColor(plan.key, i)}
              shopsOn={shops.filter((s) => s.planKey === plan.key).length}
              revenue={plan.priceCents * shops.filter((s) => s.planKey === plan.key && s.status === 'active').length}
              successorName={plans.find((p) => p.key === plan.successorPlanKey)?.name ?? null}
              onEdit={() => setEditing(plan.key)}
              onRetire={() => setRetiring(plan.key)}
            />
```

- [ ] **Step 5: Verify it renders**

Run:
```bash
npx tsc --noEmit
```
Expected: no errors. `retiring` is set but not yet read — Task 8 adds the modal that consumes it.

Then run the app, sign in to the portal as a platform admin, open Plans, and confirm every card now shows Edit + Retire and no card shows a countdown (nothing is retired yet).

- [ ] **Step 6: Commit**

```bash
git add src/components/platform/plans-tab.tsx
git commit -m "feat: show a plan's retirement countdown and successor on its card"
```

---

### Task 8: The retire sheet

**Files:**
- Create: `src/components/platform/plan-retire-modal.tsx`
- Modify: `src/components/platform/plans-tab.tsx` — render the modal off the `retiring` state added in Task 7

**Interfaces:**
- Consumes: `retire_plan` / `republish_plan` (Task 3), `Plan.retireAt` / `Plan.successorPlanKey` (Task 5), `callPlatformAdmin` from `@/lib/platform`.
- Produces: `PlanRetireModal` — props `{ plan: Plan; plans: Plan[]; shopsOn: number; pendingRequests: number; postTrialPlanKey: string; onClose: () => void; onDone: () => Promise<void> }`.

- [ ] **Step 1: Write the component**

Create `src/components/platform/plan-retire-modal.tsx`:

```tsx
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { ActionRow, Chip, Field, PlatformButton, SectionLabel } from '@/components/platform/kit';
import { Caveat } from '@/components/ui/caveat';
import { Colors } from '@/constants/theme';
import { callPlatformAdmin } from '@/lib/platform';
import type { Plan } from '@/lib/subscriptions';

// Pinned to the light palette for now — no dark-mode switching yet.
const theme = Colors.light;

// Withdrawing a tier from sale. Hidden from the chooser at once; the stores on
// it keep everything for 30 days and are told where they are going; on the date
// shop_effective_plan() resolves them to the successor. Nothing is bulk-updated,
// so republishing before the date undoes all of it.
export function PlanRetireModal({
  plan,
  plans,
  shopsOn,
  pendingRequests,
  postTrialPlanKey,
  onClose,
  onDone,
}: {
  plan: Plan;
  plans: Plan[];
  shopsOn: number;
  pendingRequests: number;
  postTrialPlanKey: string;
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  // A plan can only receive stores if it is offered, staying, and active.
  // `trial` fails the first test — it is assigned by the signup trigger and
  // never chosen, so it can never be a destination either.
  const candidates = plans.filter((p) => p.key !== plan.key && p.isPublic && !p.retireAt);
  const [successor, setSuccessor] = useState<string | null>(candidates[0]?.key ?? null);
  const [fallback, setFallback] = useState<string | null>(candidates[0]?.key ?? null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const republishing = plan.retireAt != null;
  // Free is reached by falling THROUGH this setting, not by being on it, so
  // retiring the fallback without naming a new one hands every lapsed store the
  // successor's entitlements for nothing.
  const isFallback = postTrialPlanKey === plan.key;
  const successorName = plans.find((p) => p.key === successor)?.name ?? '';

  const run = async () => {
    if (!reason.trim()) {
      setError('A reason is required for every change.');
      return;
    }
    if (!republishing && !successor) {
      setError('Choose where these stores go.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (republishing) {
        await callPlatformAdmin('republish_plan', { planKey: plan.key }, reason.trim());
      } else {
        await callPlatformAdmin(
          'retire_plan',
          {
            planKey: plan.key,
            successorPlanKey: successor,
            ...(isFallback ? { postTrialPlanKey: fallback } : {}),
          },
          reason.trim()
        );
      }
      await onDone();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not change that plan.');
    } finally {
      setBusy(false);
    }
  };

  if (republishing) {
    return (
      <View>
        <Text style={styles.meta}>
          key `{plan.key}` — {shopsOn} store{shopsOn === 1 ? '' : 's'} on it
        </Text>
        <View style={styles.caveat}>
          <Caveat tone="context">
            {`Putting ${plan.name} back on sale. The ${shopsOn} store${
              shopsOn === 1 ? '' : 's'
            } on it stay exactly where they are — nothing was ever moved. Where lapsed stores land is a separate setting and is not restored by this; check it in Settings if you changed it when retiring.`}
          </Caveat>
        </View>

        <SectionLabel>Reason</SectionLabel>
        <Field
          value={reason}
          onChangeText={setReason}
          placeholder="Reason (required — goes into the audit log)"
          needed={!reason.trim()}
        />
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <ActionRow style={styles.footer}>
          <PlatformButton label={busy ? 'Saving…' : 'Republish plan'} disabled={busy || !reason.trim()} onPress={run} />
          <Pressable onPress={onClose}>
            <Text style={styles.cancel}>Cancel</Text>
          </Pressable>
        </ActionRow>
      </View>
    );
  }

  return (
    <View>
      <Text style={styles.meta}>
        key `{plan.key}` — {shopsOn} store{shopsOn === 1 ? '' : 's'} depend on it
        {pendingRequests > 0 ? `, ${pendingRequests} pending request${pendingRequests === 1 ? '' : 's'}` : ''}
      </Text>

      <SectionLabel>Move them to</SectionLabel>
      <ActionRow>
        {candidates.map((p) => (
          <Chip
            key={p.key}
            label={p.priceCents === 0 ? p.name : `${p.name} · ${(p.priceCents / 100).toFixed(0)}/${p.billingInterval ?? 'month'}`}
            active={successor === p.key}
            onPress={() => setSuccessor(p.key)}
          />
        ))}
      </ActionRow>

      {isFallback ? (
        <>
          <SectionLabel>New home for lapsed stores</SectionLabel>
          <ActionRow>
            {candidates.map((p) => (
              <Chip key={p.key} label={p.name} active={fallback === p.key} onPress={() => setFallback(p.key)} />
            ))}
          </ActionRow>
          <View style={styles.caveat}>
            <Caveat tone="wrong" action={{ label: 'Cancel this', onPress: onClose }}>
              {`${plan.name} is where lapsed stores land, and they get there by falling through the setting rather than by being on the plan. Retiring it without naming a new home would hand every expired store on the platform ${successorName}'s features for nothing.`}
            </Caveat>
          </View>
        </>
      ) : null}

      {pendingRequests > 0 ? (
        <View style={styles.caveat}>
          <Caveat tone="wrong" action={{ label: 'Cancel this', onPress: onClose }}>
            {`${pendingRequests} store${
              pendingRequests === 1 ? ' has' : 's have'
            } asked to move onto ${plan.name}. Those requests can no longer be approved once it is retiring — decline them and move those stores to ${successorName} instead.`}
          </Caveat>
        </View>
      ) : null}

      <View style={styles.caveat}>
        <Caveat tone="context">
          {`Hidden from the plan picker straight away. Nothing changes for the ${shopsOn} store${
            shopsOn === 1 ? '' : 's'
          } on it for 30 days — they keep everything, and you can move any of them sooner from Stores. Republishing before then undoes all of it.`}
        </Caveat>
      </View>

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
          label={busy ? 'Saving…' : 'Retire plan'}
          disabled={busy || !reason.trim() || !successor}
          danger
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
  meta: { fontSize: 11, color: theme.bentoMuted, marginBottom: 4 },
  caveat: { marginTop: 14 },
  error: { color: theme.bentoLoss, fontSize: 12, fontWeight: '700', marginTop: 8 },
  footer: { marginTop: 14 },
  cancel: { color: theme.bentoMuted, fontSize: 12, fontWeight: '700', paddingHorizontal: 8 },
});
```

- [ ] **Step 2: Render it from `PlansTab`**

In `src/components/platform/plans-tab.tsx`, add the import:

```ts
import { PlanRetireModal } from '@/components/platform/plan-retire-modal';
```

Add two props to `PlansTab` so it can answer the two questions the modal asks — the existing `onDone` and `compact` stay as they are:

```ts
export function PlansTab({
  plans,
  shops,
  compact,
  pendingRequestsByPlanKey,
  postTrialPlanKey,
  onDone,
}: {
  plans: Plan[];
  shops: PlatformShopRow[];
  compact: boolean;
  pendingRequestsByPlanKey: Record<string, number>;
  postTrialPlanKey: string;
  onDone: () => Promise<void>;
}) {
```

Add the resolved plan beside the existing `editingPlan`:

```ts
  const retiringPlan = plans.find((p) => p.key === retiring) ?? null;
```

And render the modal after the existing `editingPlan` modal block:

```tsx
      {retiringPlan ? (
        <PlatformModal
          title={retiringPlan.retireAt ? `Republish ${retiringPlan.name}` : `Retire ${retiringPlan.name}`}
          compact={compact}
          onClose={() => setRetiring(null)}
        >
          <PlanRetireModal
            plan={retiringPlan}
            plans={plans}
            shopsOn={shops.filter((s) => s.planKey === retiringPlan.key).length}
            pendingRequests={pendingRequestsByPlanKey[retiringPlan.key] ?? 0}
            postTrialPlanKey={postTrialPlanKey}
            onClose={() => setRetiring(null)}
            onDone={onDone}
          />
        </PlatformModal>
      ) : null}
```

- [ ] **Step 3: Add a settings reader — nothing loads them today**

`platform_settings` is never read client-side: there is no `getPlatformSettings()` in `src/lib/platform.ts` and `reload()` does not fetch it. The modal needs `post_trial_plan_key` to know whether this plan is the platform's fallback, so add the reader here.

In `src/lib/platform.ts`, add beside the other readers:

```ts
export type PlatformSettings = {
  defaultTrialDays: number;
  defaultGraceDays: number;
  postTrialPlanKey: string;
};

// The singleton row from 20260818000000. Readable by any authenticated user by
// policy — the trial countdown needs default_grace_days to say when writes stop
// — so this needs no operator check of its own.
export async function getPlatformSettings(): Promise<PlatformSettings> {
  const { data, error } = await supabase
    .from('platform_settings')
    .select('default_trial_days, default_grace_days, post_trial_plan_key')
    .eq('id', true)
    .single();
  if (error) throw error;
  return {
    defaultTrialDays: data.default_trial_days,
    defaultGraceDays: data.default_grace_days,
    postTrialPlanKey: data.post_trial_plan_key,
  };
}
```

- [ ] **Step 4: Load them and feed the two props**

In `src/app/platform/index.tsx`, add `getPlatformSettings` and `type PlatformSettings` to the existing import from `@/lib/platform`, add the state:

```ts
  const [settings, setSettings] = useState<PlatformSettings | null>(null);
```

add the call to the `Promise.all` in `reload()` (as rewritten in Task 6, Step 6):

```ts
    const [shopRows, auditRows, operatorRows, requestRows, paymentRows, settingsRow] = await Promise.all([
      listPlatformShops(planRows),
      listAuditLog(),
      listOperators(),
      listPendingPlanRequests(),
      listSubscriptionPayments(),
      getPlatformSettings(),
    ]);
```

and set it alongside the other setters:

```ts
    setSettings(settingsRow);
```

Then add the two props where `<PlansTab ... />` is rendered. `listPendingPlanRequests()` already filters to pending only, so no status filter is needed here:

```tsx
          pendingRequestsByPlanKey={requests.reduce<Record<string, number>>(
            (acc, r) => ({ ...acc, [r.planKey]: (acc[r.planKey] ?? 0) + 1 }),
            {}
          )}
          postTrialPlanKey={settings?.postTrialPlanKey ?? 'free'}
```

- [ ] **Step 5: Verify end to end**

Run:
```bash
npx tsc --noEmit && npm test
```
Expected: no type errors, all tests pass.

Then in the running app, as a platform admin: open Plans → Retire on Standard → confirm the successor chips exclude Standard and Trial, enter a reason, save. The card should show the countdown chip and the amber strip, and the tier should disappear from a shop's billing screen. Then Republish it and confirm everything returns.

Finally retire **Free** and confirm the extra "New home for lapsed stores" section and its `wrong` caveat appear, because `free` is the current `post_trial_plan_key`.

- [ ] **Step 6: Commit**

```bash
git add src/components/platform/plan-retire-modal.tsx src/components/platform/plans-tab.tsx src/app/platform/index.tsx src/lib/platform.ts
git commit -m "feat: retire and republish a plan from the Plans tab"
```

---

### Task 9: The "Retiring plan" filter

**Files:**
- Modify: `src/components/platform/shops-tab.tsx` — `FILTERS` at lines 25-32, `StatusFilter` at line 23, `filtered` at lines 50-59, `counts` at lines 61-78

**Interfaces:**
- Consumes: `PlatformShopRow.retiringTo` (Task 6).
- Produces: nothing other tasks read.

- [ ] **Step 1: Add the filter key and segment**

In `src/components/platform/shops-tab.tsx`, widen the filter type:

```ts
// 'retiring' is not a subscription status — it is a plan-lifecycle fact — but
// it belongs in the same control because it answers the same question the
// operator is asking: which stores need me to do something?
type StatusFilter = 'all' | 'retiring' | SubscriptionStatus;
```

Append to `FILTERS`:

```ts
  { key: 'retiring', label: 'Retiring plan' },
```

- [ ] **Step 2: Filter on it**

In the `filtered` memo, replace the status line:

```ts
      if (status === 'retiring') {
        if (!shop.retiringTo) return false;
      } else if (status !== 'all' && shop.status !== status) {
        return false;
      }
```

- [ ] **Step 3: Count it**

In the `counts` memo, add to the returned object:

```ts
      retiring: shops.filter((shop) => shop.retiringTo != null).length,
```

- [ ] **Step 4: Show where they are going in the row**

`NameCell` is `{ title, meta }` (`src/components/ui/data-table.tsx:98`) and renders `meta` as a second, quieter line — exactly what this needs. Find the plan column in `columns` and give it the destination:

```tsx
        <NameCell title={shop.planName} meta={shop.retiringTo ? `→ ${shop.retiringTo}` : undefined} />
```

Pass `undefined`, not `''`. `NameCell` guards with a ternary specifically because an empty string is a bare text node inside a `View`, which is a hard error on RN Web.

- [ ] **Step 5: Verify**

Run:
```bash
npx tsc --noEmit
```
Expected: no errors.

In the app: retire a plan that has stores on it, open Stores, and confirm the "Retiring plan" segment shows a non-zero count and filters to exactly those stores.

- [ ] **Step 6: Commit**

```bash
git add src/components/platform/shops-tab.tsx
git commit -m "feat: filter the store list to those on a retiring plan"
```

---

### Task 10: The shop's warning

**Files:**
- Modify: `src/components/settings/panels/billing-panel.tsx`

**Interfaces:**
- Consumes: `Plan.retireAt`, `Plan.successorPlanKey` (Task 5), `listAllPlans` from `@/lib/subscriptions`.
- Produces: nothing other tasks read.

**THIS FILE IS CREAM, NOT BENTO.** It uses `Section` / `Row` / `Badge` / `Btn` from `settings-primitives` and the `background` / `surface` / `border` tokens. Do not import a single `bento*` token into it.

- [ ] **Step 1: Load the store's own plan, retired or not**

`listPlans()` filters `is_public`, so the moment a plan is retired it vanishes from `plans` here — including the store's *current* plan, which is exactly the one we need to warn about. Fetch the full list too.

Change the import:

```ts
import {
  cancelPlanChangeRequest,
  getMyPlanChangeRequest,
  listAllPlans,
  listPlans,
  requestPlanChange,
  type Plan,
  type PlanChangeRequest,
} from '@/lib/subscriptions';
```

Add state beside the existing `plans` state:

```ts
  // The store's own plan may have been retired, in which case listPlans() no
  // longer returns it — and that is precisely the plan we have to warn about.
  const [myPlan, setMyPlan] = useState<Plan | null>(null);
```

In the existing `useEffect`, extend the `Promise.all` and set it:

```ts
    Promise.all([
      listPlans().catch(() => [] as Plan[]),
      listAllPlans().catch(() => [] as Plan[]),
      shop ? getMyPlanChangeRequest(shop.id).catch(() => null) : null,
    ])
      .then(([planRows, allPlanRows, requestRow]) => {
        if (!active) return;
        setPlans(planRows);
        const mine = allPlanRows.find((p) => p.key === entitlements.planKey) ?? null;
        setMyPlan(mine);
        setSuccessorName(allPlanRows.find((p) => p.key === mine?.successorPlanKey)?.name ?? null);
        setRequest(requestRow);
      })
```

Add the successor-name state beside `myPlan`:

```ts
  const [successorName, setSuccessorName] = useState<string | null>(null);
```

Add `entitlements.planKey` to the effect's dependency array alongside `shop`.

- [ ] **Step 2: Render the banner**

**Use this file's own banner idiom, not `Caveat`.** The panel already renders notices with `styles.requestBanner` / `styles.requestBannerText` (lines 283-287) for the pending and declined request cases. Reuse that shape — it is already cream, already sized, and needs no `action` prop, which matters because there is no scroll target on this screen to point a `Caveat` action at.

Add an amber variant beside the existing blue one in the `StyleSheet.create` block:

```ts
  // Same shape as requestBanner, amber rather than blue. A pending request is
  // neutral news; a plan ending under you is not.
  retireBanner: {
    backgroundColor: '#FFFBEB', borderWidth: 1, borderColor: '#F0D9A0', borderRadius: 10,
    padding: 14, marginBottom: 12, gap: 10, alignItems: 'flex-start',
  },
  retireBannerText: { color: '#8A5A05', fontSize: 12.5, lineHeight: 19 },
```

Inside the existing `<Section title="Your plan">`, immediately after the status card block closes, insert:

```tsx
        {myPlan?.retireAt && successorName ? (
          <View style={styles.retireBanner}>
            <Text style={styles.retireBannerText}>
              The {myPlan.name} plan is ending on {new Date(myPlan.retireAt).toLocaleDateString()}. On that day this
              store moves to {successorName}, and nothing you have entered will be deleted. Have a look at the other
              plans below if you would rather pick for yourself.
            </Text>
          </View>
        ) : null}
```

No new imports: `View` and `Text` are already imported at the top of the file.

- [ ] **Step 3: Verify**

Run:
```bash
npx tsc --noEmit && npm test
```
Expected: no type errors, all tests pass.

In the app: retire the plan a test store is on, then open that store's Settings → Plan and billing. Confirm the amber banner names the plan, the date and the successor, and that the retired plan no longer appears in the "Plans" list below.

- [ ] **Step 4: Commit**

```bash
git add src/components/settings/panels/billing-panel.tsx
git commit -m "feat: warn a store when its plan is being retired"
```

---

### Task 11: Server-side floor under the trial credit

**Files:**
- Modify: `supabase/functions/platform-admin/index.ts` — the `record_payment` case at lines 199-247

**Interfaces:**
- Consumes: nothing from earlier tasks. Independent of Tasks 1-10.
- Produces: `record_payment` returns HTTP 400 `covers_to_before_trial_end` when `coversTo` precedes the trial end and `endTrialNow` is not set.

- [ ] **Step 1: Understand what is already right**

`RecordPayment` in `src/components/platform/shop-drawer.tsx:296-307` already computes the period start as the latest of today, current cover, and trial end, and `startNow` is off by default. **That behaviour is correct and must not change.** The gap is only that `record_payment` writes `coversTo` verbatim, so the guarantee lives in one React component and a hand-edited date silently burns a customer's free days.

- [ ] **Step 2: Add the clamp**

In the `record_payment` case, immediately after `const before = await loadSubscription(body.shopId);`, insert:

```ts
        // The fairness rule the drawer already applies, enforced where it
        // cannot be edited around: paid time starts when free time ends. A
        // store that pays 40 days into a 90-day trial buys a month AFTER the
        // trial, not a month that overlaps days they already had. endTrialNow
        // is the deliberate opt-out, for a store that asks to convert early.
        if (p.coversTo && !p.endTrialNow && before?.trial_ends_at) {
          const trialEnd = new Date(before.trial_ends_at);
          if (trialEnd > new Date() && new Date(p.coversTo) < trialEnd) {
            return errorResponse(
              400,
              'covers_to_before_trial_end',
              `Cover cannot end before their trial does on ${trialEnd.toISOString().slice(0, 10)}. Tick "start paying today" if they asked to convert early.`
            );
          }
        }
```

- [ ] **Step 3: Deploy and verify by hand**

Run:
```bash
supabase functions deploy platform-admin
```

Then in the portal, open a trialing store, Record payment, and hand-edit "covers to" to a date before the trial end with the "start paying today" box unticked.
Expected: refused with "Cover cannot end before their trial does on …". Ticking the box and retrying succeeds.

- [ ] **Step 4: Commit**

```bash
git add supabase/functions/platform-admin/index.ts
git commit -m "fix: refuse a payment period that ends before the trial does"
```

---

### Task 12: Period length follows the billing interval

**Files:**
- Modify: `src/components/platform/shop-drawer.tsx` — lines 314, 331, 398, and `addMonths` at line 420

**Interfaces:**
- Consumes: `Plan.billingInterval` (already on the type).
- Produces: nothing other tasks read.

- [ ] **Step 1: Write the failing test**

Create `src/lib/__tests__/billing-period.test.ts`:

```ts
import { periodMonths } from '@/lib/billing-period';

// addMonths(from, 1) was hardcoded at three call sites in shop-drawer.tsx, so a
// yearly plan handed the operator a one-month period and relied on them
// noticing. Latent rather than live — no seeded plan uses 'year' — which is
// exactly the kind of bug that ships the day one does.

describe('periodMonths', () => {
  it('gives a monthly plan one month', () => {
    expect(periodMonths('month')).toBe(1);
  });

  it('gives a yearly plan twelve months', () => {
    expect(periodMonths('year')).toBe(12);
  });

  it('falls back to one month when a plan has no interval', () => {
    // Free and Trial both have a null interval. They are never paid for, but
    // the drawer still renders defaults for them.
    expect(periodMonths(null)).toBe(1);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run:
```bash
npx jest src/lib/__tests__/billing-period.test.ts
```
Expected: FAIL — cannot find module `@/lib/billing-period`.

- [ ] **Step 3: Write the helper**

Create `src/lib/billing-period.ts`:

```ts
// How many months one billing period covers. Its own module rather than a
// local in shop-drawer.tsx because the period defaults are read at three call
// sites there and the rule is worth testing on its own.
export function periodMonths(interval: 'month' | 'year' | null): number {
  return interval === 'year' ? 12 : 1;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run:
```bash
npx jest src/lib/__tests__/billing-period.test.ts
```
Expected: PASS, 3 tests.

- [ ] **Step 5: Use it at all three call sites**

In `src/components/platform/shop-drawer.tsx`, add the import:

```ts
import { periodMonths } from '@/lib/billing-period';
```

Add beside the existing `plan` lookup in `RecordPayment`:

```ts
  const months = periodMonths(plan?.billingInterval ?? null);
```

Line 314 — the initial state:
```ts
  const [coversTo, setCoversTo] = useState(addMonths(from, months));
```

Line 331 — inside `applyStartNow`:
```ts
    setCoversTo(addMonths(start, months));
```

Line 398 — the quick-pick chips. Leave the explicit `+1 / +3 / +6 / +12` chips exactly as they are: they are deliberate manual overrides for a store paying an odd number of periods, and making them interval-relative would make "+3" mean three years on a yearly plan.

- [ ] **Step 6: Verify**

Run:
```bash
npx tsc --noEmit && npm test
```
Expected: no type errors, all tests pass.

In the app: open a store on a monthly plan and confirm the default period is still one month. (No seeded plan uses `year`; to check that branch, temporarily set `billing_interval = 'year'` on a plan in the local database and confirm the default becomes twelve months.)

- [ ] **Step 7: Commit**

```bash
git add src/lib/billing-period.ts src/lib/__tests__/billing-period.test.ts src/components/platform/shop-drawer.tsx
git commit -m "fix: default a payment period to the plan's own billing interval"
```

---

## Final verification

- [ ] **Run the whole TypeScript suite**

```bash
npx tsc --noEmit && npm test && npm run lint
```
Expected: no type errors, all tests pass, no lint errors.

- [ ] **Run the whole migration chain from empty, then every SQL check**

```bash
supabase db reset
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -f supabase/tests/verify-entitlements.sql
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -f supabase/tests/verify-platform-portal.sql
```
Expected: `ALL CHECKS PASSED` from both.

- [ ] **Walk the whole feature once**

Retire Standard → it vanishes from a shop's billing screen, the card shows a countdown, the Stores tab counts the affected stores, the affected store sees the amber banner. Approve a pending request onto Standard → refused. Republish Standard → everything returns and the store's plan is unchanged.

## Spec coverage

| Spec item | Task |
|---|---|
| A1 two columns | 1 |
| A2 resolver hop | 2 |
| A3 `retire_plan` / `republish_plan` | 3 |
| A4 `Plan` fields | 5 |
| A5 `listPlatformShops` resolves | 6 |
| A6 plan card | 7, 8 |
| A7 shops filter | 9 |
| A8 billing banner | 10 |
| A9 approval guard | 4 |
| B1 `addMonths` interval | 12 |
| B2 server-side floor | 11 |
| SQL proof of the hop | 2 |
| SQL proof of the rejections | 3, 4 |
| Landing page stays hardcoded | out of scope, by design |
