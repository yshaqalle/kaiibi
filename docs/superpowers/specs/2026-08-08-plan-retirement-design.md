# Retiring a plan

Mockup: [docs/design/plan-retirement-mockup.html](../../design/plan-retirement-mockup.html)

## The problem

Plans live in a table rather than in code so that pricing and packaging can change
without a deploy — `20260818000000_plans_and_subscriptions.sql` says so outright:
"Rows, not code, so pricing and packaging change from the admin portal without a
deploy."

Withdrawing a tier is the one packaging change that still needs a deploy. Commit
`0be1bae` removed Free from sale by editing hardcoded copy in
`src/components/landing/landing-plans.tsx` and two i18n message files. That edit
only changed the marketing page: the tier stayed in `listPlans()`, so it was still
offered inside the app on the billing screen.

The column that should have made this a data change already exists.
`plans.is_public` is documented as "Whether a shop can see and choose this plan",
and `listPlans()` already filters `.eq('is_public', true).eq('active', true)`.
`plans-tab.tsx` even renders a `"Not public"` chip. Nothing in the portal can set
the column — `PlanEditor` sends `key`, `name`, `price_cents`, `modules` and
`limits`, and no other caller writes to `plans`.

So the shop-facing half of this feature is already built and unreachable.

## What we are building

Retiring a plan is one operator action with three effects:

1. The plan disappears from the shop's chooser immediately. No new store can land
   on it.
2. Stores already on it keep everything for 30 days and are told, from day one,
   what is happening and where they will go.
3. On the date, they move to a named successor plan.

Republishing before the date undoes all of it.

Retirement is deliberately **not** `active = false`. That column stays what it is:
the hard "this plan is gone" switch, protected by the `on delete restrict` on
`shop_subscriptions.plan_id`, whose comment already says the portal deactivates
plans rather than deleting them. Retirement is the graceful path that runs first.

## Why derived, not migrated

The obvious implementation is a scheduled job that rewrites `plan_id` on every
affected subscription when the date arrives. We are not doing that, for a reason
the entitlement layer states in its own header:

> subscription STATUS IS COMPUTED, NOT STORED. There is no status column anyone
> has to remember to update and no nightly job whose failure leaves a lapsed shop
> reading as active.

There is also no `pg_cron` anywhere in this project, so a job would be new
infrastructure whose failure mode is silent and whose effect is irreversible —
once 218 subscriptions have been rewritten, republishing cannot bring anyone back.

Instead the retirement is two columns on the plan row and one extra hop in
`shop_effective_plan()`. Nothing is ever bulk-updated. Clearing `retire_at`
restores every affected store instantly, because nothing was destroyed.

The cost is that `shop_subscriptions.plan_id` and the effective plan diverge for
retired-past-date stores. Server-side that is already handled: `shop_has_module`
and the limit checks all funnel through `shop_effective_plan`. Client-side there
is exactly one offender, and it is called out as A5 below.

## Schema

```sql
alter table public.plans
  add column retire_at          timestamptz,
  add column successor_plan_key text references public.plans(key),
  add constraint plans_retire_needs_successor
    check (retire_at is null or successor_plan_key is not null),
  add constraint plans_successor_not_self
    check (successor_plan_key is distinct from key);
```

`plans.key` is already `unique`, so the foreign key works as written and
guarantees the successor exists. Both columns are null on every existing row, so
the migration is a no-op for current behaviour.

`retire_at` is the date stores move, not the date the plan was hidden. Hiding is
`is_public = false` and happens the moment the action runs.

## Resolution

`shop_effective_plan()` gains one hop. Current body resolves a key and selects the
plan; the new body resolves the key, follows the successor if that plan is past
its `retire_at`, and then selects.

```sql
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

`shop_effective_status()` is untouched. Retirement changes *which plan applies*,
never *what status the store is in* — a store on a retired plan is not lapsed, and
must not read as such.

**One hop, not a chain.** A recursive resolve would turn an operator mistake into
an infinite loop at read time, inside a function called on every gated write. The
edge function refuses to retire into a plan that is itself retiring, and when
retiring plan B it re-points any plan whose successor was B onto B's own
successor. That keeps every chain one hop long by construction, so the resolver
never needs to walk one.

## The Free problem

Retiring Free is not like retiring a paid plan, and the design has to name this
because the failure is silent.

`shop_effective_status` is dates-only. A store on Free has no trial left, no
`current_period_end` and no grace, so it already derives to `expired` — and
`shop_effective_plan` sends every expired store to
`platform_settings.post_trial_plan_key`, which is `'free'`. **Free is not reached
by being on Free. It is reached by falling through.**

So retiring Free with Standard as successor resolves like this: expired store →
`post_trial_plan_key` → `free` → retired → **Standard**. Every lapsed store on the
platform silently gains Standard's entitlements for nothing.

Therefore: **retiring the plan named in `post_trial_plan_key` requires setting a
new fallback in the same action.** The portal makes the field mandatory and the
edge function re-checks it, writing both changes in one call so the two can never
be out of step.

> **Open, assumed for now.** The mockup assumes the new floor is a smaller free
> tier called **Starter**. That plan does not exist yet. If the floor should be
> something else — or if lapsed stores should land somewhere with no modules at
> all — the retire sheet and the shop's banner copy change, but nothing structural
> does. This does not block A1, A2, A4, A5, B1 or B2.

## The actions

Two new cases in `supabase/functions/platform-admin/index.ts`, using the existing
`audit()` helper and the mandatory-reason field every platform action already
carries.

**`retire_plan`** — `{ planKey, successorPlanKey, retireAt?, postTrialPlanKey? }`

Sets `is_public = false`, `retire_at` (default `now() + 30 days`),
`successor_plan_key`. Rejects when:

- the successor does not exist, or is not `active`
- the successor is the plan itself
- the successor is `is_public = false` — `trial` is assigned by trigger and can
  never be chosen, so it can never be a destination
- the successor is itself retiring
- the plan is `post_trial_plan_key` and no replacement `postTrialPlanKey` is given

Also re-points any plan whose `successor_plan_key` is this plan onto this plan's
successor, per the one-hop rule above.

**`republish_plan`** — `{ planKey }`

Sets `is_public = true`, `retire_at = null`, `successor_plan_key = null`. Does not
attempt to undo a `post_trial_plan_key` change — that is a separate deliberate
setting and restoring it silently could relocate lapsed stores nobody asked to
move. The portal says so when republishing a plan that was the fallback.

Neither action touches `active` or any `shop_subscriptions` row.

## Client

**A4 — `src/lib/subscriptions.ts`.** Add `retireAt: string | null` and
`successorPlanKey: string | null` to `Plan` and to `mapPlanRow`. `listPlans()`
needs no change: its existing `is_public` filter is what makes a retired plan
vanish from the shop's chooser on day one. `listAllPlans()` needs no change
either — the portal wants every plan, retiring or not.

**A5 — `src/lib/platform.ts`.** `listPlatformShops()` joins
`plans(key, name, limits)` directly off the subscription row, so once `retire_at`
passes it would show the operator the dead plan's name and the dead plan's limits
while the server enforces the successor's. MRR and every usage bar in the portal
would be wrong, silently, for exactly the stores under management.

Fix by resolving through the successor client-side, mirroring the server rule the
same way `deriveStatus()` at `platform.ts:174` already mirrors
`shop_effective_status`. The existing comment there — "the server remains the
authority for enforcement; this is just so the list can be sorted and filtered
without one RPC per row" — applies unchanged.

**A6 — `plans-tab.tsx`.** A Retire / Republish control beside the existing Edit
button. The `"Not public"` chip at line 116 becomes a countdown chip when
`retireAt` is set, and an amber strip under the stats names the date, the store
count and the successor. `bentoWarn` carries a glyph as well as its colour —
colour alone is never the signal.

**A7 — `shops-tab.tsx`.** One more filter segment, "Retiring plan", with the
affected count on it, so moving a store early with the existing `set_plan` action
is a visible task rather than a per-store hunt. The count reaching zero before the
date is the operator's own progress bar.

**A8 — `billing-panel.tsx`.** The warning banner, live from the moment of
retirement rather than the last week. `Caveat` `wrong` tone with an action, per
the tone rules — a `wrong` caveat with nothing to do trains people to ignore the
whole family.

**This screen is cream, not bento.** Settings has not been converted; it reads
`background` / `surface` / `border`, and `Caveat`'s `wrong` tone hardcodes
`#8A5A05`. Do not half-apply bento tokens here.

**A9 — in-flight plan change requests.** A store can have a pending request to
*move onto* the plan being retired. The insert policy in
`20260818000700_plan_change_requests.sql:52` checks the permission, the status and
the requester, but **not `is_public`** — so requests for a retiring plan already
exist the moment it is retired, and `approve_plan_change` would move that store
onto a plan that is shutting down, which is the exact opposite of the intent.

Reject at approval: `approve_plan_change` returns an error when the requested plan
has `retire_at` set, in the same shape as the existing `already_decided` guard
(which exists for the same class of reason — a decision made against state that
has since changed). The operator declines it and moves the store to the successor
instead.

Surface it at retirement: the retire sheet counts pending requests for the plan
alongside the affected store count, so an operator sees "218 stores, 3 pending
requests" before confirming rather than discovering them in the queue afterwards.

Not doing: adding `is_public` to the insert policy. It would be correct, but it
widens this work into the request system's own validation rules and the approval
guard already closes the hole this feature opens.

## Out of scope

`src/components/landing/landing-plans.tsx` stays hardcoded. Its own comment says
static copy is deliberate while prices are unannounced. **Retiring a plan in the
portal will not change the marketing page** — the two can drift, and that is an
accepted cost, not an oversight. Wiring the landing page to `listPlans()` is a
separate decision to be made when pricing is announced.

## Also in this work: two trial-credit fixes

The requirement that a converting store keeps its remaining trial days is
**already implemented and correct**. `RecordPayment` in
`src/components/platform/shop-drawer.tsx:296` computes the period start as the
latest of today, current cover, and trial end; the "start paying today" toggle is
off by default and warns that turning it on gives up the free days. `endTrialNow`
is an opt-in override for a store that asks to convert early, not a bug.

Two gaps remain around it.

**B1 — `addMonths(from, 1)` ignores `billing_interval`.** Three call sites
hardcode months: `shop-drawer.tsx:314`, `:331`, `:398`. On a `year` plan the
operator is handed a one-month period and has to catch it. Derive the default from
`plan.billingInterval`. Latent, not live — no plan uses `year` today.

**B2 — the fairness rule has no server-side floor.** `record_payment` writes
`coversTo` verbatim. The guarantee lives in one React component, so a hand-edited
date field silently burns the free days. Clamp `covers_to` server-side to at least
`max(now(), trial_ends_at)` unless `endTrialNow` is set, and return a message the
drawer can show.

These are independent of the retirement work and of each other.

## Proving it

**`supabase/tests/verify-entitlements.sql`** — the load-bearing proof, since the
whole design rests on one SQL function:

- a store on a plan with `retire_at` in the future keeps that plan's modules and
  limits
- the same store past `retire_at` resolves to the successor's modules and limits
- its `shop_effective_status` is unchanged throughout — retirement must never make
  a store read as lapsed
- clearing `retire_at` restores the original plan
- a lapsed store still resolves through `post_trial_plan_key`, and correctly
  through the successor when that fallback plan is itself retired

**`supabase/tests/verify-platform-portal.sql`** — `retire_plan` rejects each
invalid successor, rejects retiring the fallback plan without a replacement, and
`approve_plan_change` rejects a request whose target plan is retiring (A9).

**Jest** — `listPlatformShops()` reports the successor's plan name and limits for a
store past `retire_at` (A5); `addMonths` defaults to twelve months on a `year`
plan (B1).

## Order of work

A1 and A2 first — the schema and the resolver, with the SQL tests, since
everything else reads what they establish. Then A3 and A9 together, since both are
edge-function guards over the same state. Then A4 and A5 together (A5 is the one
that makes the portal tell the truth). A6, A7 and A8 are independent of each other
once A4 lands. B1 and B2 can be done at any point.
