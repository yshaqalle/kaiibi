# Creating, publishing and archiving a plan

Mockup: [docs/design/plan-lifecycle-mockup.html](../../design/plan-lifecycle-mockup.html)

## The problem

Retirement shipped (2026-08-08). The lifecycle it belongs to is still missing both
ends.

**Create.** `upsert_plan` is an upsert on `key`, so the server already creates
plans — but no UI reaches it in create mode: `PlanEditor` is only opened from an
existing card's Edit button. Worse, a plan created through it would be born
`is_public = true` (the column default), live in every store's plan picker before
its modules are ticked. The handler's own comment names this gap: excluding
`is_public` from the allowlist left "no API path to CREATE a non-public plan."

**Archive.** `active = false` is the schema's designed terminal state — the
`on delete restrict` comment on `shop_subscriptions.plan_id` says "the portal
deactivates plans (active = false) instead of deleting them" — but `active` is
deliberately outside `upsert_plan`'s allowlist and nothing else writes it. And
every plan query filters `active = true`, so an archived plan would vanish from
the portal itself: a one-way door with no handle on the other side.

**Delete** stays never. Nothing in this work adds one; the row, its audit trail
and its revenue history outlive the plan.

## What we are building

Three operator actions closing the lifecycle: **retire → drain → archive**, and
at the other end **create hidden → build → publish**.

1. **Create** — a dashed ghost cell at the end of the tier grid opens
   `PlanEditor` in create mode. The plan is created with `is_public = false`.
2. **Publish** — a hidden, never-retired plan's card gains a Publish button.
   One new action flips `is_public` on.
3. **Archive / Restore** — a drained, non-public plan's card gains an Archive
   button; archived plans drop into a collapsed strip below the grid, each row
   with Restore.

### Decisions resolved at mockup review

- **Archive requires drained, not retired**: 0 subscription rows + not public.
  A full retirement first would make killing a never-launched draft absurd —
  retire it to whom?
- **No billing interval or currency fields** in the create sheet. Every plan is
  monthly USD today; both columns keep their defaults. Adding fields later is
  trivial; adding them now is two more ways to misconfigure a plan.
- **Created hidden is not optional.** There is no "create public" checkbox; the
  only path to the picker is the Publish button on a card the operator has
  looked at.

## Server

All in `supabase/functions/platform-admin/index.ts`, using the existing
`audit()` helper and the mandatory reason every platform action carries.

### `upsert_plan` — create mode

The action gains a `create: true` flag rather than a separate action, because
the payload and the audit shape are identical. When set:

- the key must match `^[a-z][a-z0-9_]*$` — it becomes the audit and billing
  identifier and can never change
- an existing row under that key is a 409, not an overwrite — without this,
  typing `standard` into the create sheet would silently rewrite Standard
- the insert forces `is_public = false` — not accepted from the client at
  all, so "created hidden" is a server property, not a portal convention

Edit mode is untouched: `is_public` stays off the allowlist there, so the
existing "no second door to publishing" property holds — publishing goes through
`publish_plan` and its guards or not at all.

### `publish_plan` — `{ planKey }`

Sets `is_public = true`, nothing else. Rejects when:

- the plan does not exist, or is already public ("nothing to publish")
- `retire_at` is set — republish is the correct verb there, and it clears the
  retirement state; publish must not mint a public-but-retiring plan
- `active = false` — restore first
- **the key is `trial`** — the same tripwire `republish_plan`'s `retire_at`
  guard exists for: `trial` is $0, carries every module and has no limits, and
  the store-facing chooser lists on `is_public` alone. One benign-looking call
  would make the whole product free. `republish_plan` is protected by accident
  of state (`trial` is never retiring); `publish_plan` has to refuse it by name.

### `archive_plan` — `{ planKey }`

Sets `active = false`, nothing else. Rejects when:

- the plan does not exist, or is already archived
- `is_public = true` — off the picker first (retired, or never published)
- **any `shop_subscriptions` row references it** — counted over all rows, not
  just active stores: `plan_id`'s restrict rule makes no status distinction and
  neither do we
- it is `platform_settings.post_trial_plan_key` — lapsed stores resolve through
  that key on every entitlement read
- **any plan's `successor_plan_key` names it** — an in-flight retirement would
  sweep its stores onto an inactive plan on the retire date. (`retire_plan`
  already refuses an inactive successor at set time; this closes the same hole
  from the other side.)
- **the key is `trial`** — the provisioning trigger selects it by key at every
  shop creation; archiving it breaks signup platform-wide

### `restore_plan` — `{ planKey }`

Sets `active = true`, nothing else. Rejects only a missing or already-active
plan. Because `is_public` and `retire_at` are untouched, a restored plan comes
back exactly as it went away — retired and/or hidden — so restoring can never
surprise the store-facing picker.

### Hardening alongside: `set_plan` and `approve_plan_change` gain an `active` guard

Both currently guard `retire_at` only. An archived **retired** plan is already
rejected by that guard (`retire_at` survives archiving — nothing ever clears it
but republish). But an archived never-launched draft has `retire_at = null` and
would pass both, letting a store be moved onto an inactive plan by a path that
skips every archive guard — instantly violating the "no subscriptions point at
an archived plan" invariant the guards above establish. Same 409 shape as the
existing `plan_retiring` rejection.

`retire_plan` needs nothing: it already checks `successor.active`.

## Client

### C1 — `src/lib/subscriptions.ts`

`Plan` gains `active: boolean` (and `mapPlanRow` maps it). A new
`listPlansForPlatform()` returns **all** rows, inactive included, ordered by
`sort_order`.

`listAllPlans()` is deliberately untouched. It is not portal-only:
`billing-panel.tsx` calls it to resolve a store's own retired plan, and while a
store can never be *on* an archived plan (archive requires zero subscriptions),
widening a store-facing query's result set to fix a portal listing is backwards.
The portal screen (`src/app/platform/index.tsx:98`) switches to the new
function; nothing else does. RLS needs no change — `read plans` is
`using (true)` and both filters were always client-side.

### C2 — `src/components/platform/plan-editor.tsx`

`plan: Plan | null`, null meaning create. In create mode:

- a Key field (monospace) before Name, validated client-side against the same
  `^[a-z][a-z0-9_]*$` before enabling save, with the hint "lowercase letters,
  digits, `_` — becomes the audit and billing identifier and can never change"
- the "key … not editable, N stores depend on it" meta line is replaced by that
  hint; the blast-radius caveat never renders (nobody is on a plan that does
  not exist)
- modules start empty, limits start blank (unlimited)
- a `context` caveat states the visibility contract: "Created hidden. No store
  can see or pick it until you publish it from its card."
- the footer button says **Create hidden plan** and sends `{ create: true }`
  alongside the plan payload; the server supplies `is_public = false` itself

### C3 — `src/components/platform/plans-tab.tsx`

The tab receives all plans and splits on `active`:

- **The grid** renders active plans plus the ghost cell. The ghost takes a
  normal grid slot, so the orphan-avoiding span math at `plans-tab.tsx:59`
  counts `activePlans.length + 1`: three plans + ghost = 4 slots = 2×2, no
  orphan.
- **Publish** appears when `!isPublic && !retireAt && key !== 'trial'` —
  mirroring the server guards, per the existing rule that a button the server
  will reject is never offered. Confirm sheet names the price, module count and
  limit count it goes live with.
- **Archive** appears when `!isPublic && storedShopsOn === 0 && key !== 'trial'
  && key !== postTrialPlanKey && no plan's successorPlanKey names it` — the
  same mirror rule. `storedShopsOn` is the stored count the card already
  computes (`storedPlanKey`), matching the server's count over subscription
  rows. The confirm sheet shows the guard checklist ticked, per the mockup.
- **The archived strip** sits below the grid, collapsed by default, showing
  count, and per row: name, key, price, "archived <updated_at>", Restore.
  `updated_at` is honest here: archiving is by construction the last write to
  an archived row — the strip offers no Edit, and `upsert_plan` is only reached
  from active cards.
- Successor and fallback pickers (`PlanRetireModal`) keep receiving **active
  plans only** — the server would reject an archived successor, and per the
  mirror rule the client never offers one.

### C4 — retire modal and shops tab

Untouched. Retirement semantics, the countdown chip, the amber strip and the
"Retiring plan" filter all operate on active plans, which is exactly the set
they keep receiving.

## Out of scope

- The store-facing app changes not at all: hidden and archived plans were
  already invisible to `listPlans()`, and a store can never be subscribed to an
  archived plan.
- `landing-plans.tsx` stays hardcoded, as the retirement spec already settled.
- No `archived_at` column. `updated_at` carries the strip's date honestly (see
  C3); a dedicated column is schema for a nicety.

## Proving it

**`supabase/tests/verify-platform-portal.sql`:**

- create mode: rejects an existing key, rejects `Standard!`-shaped keys,
  creates with `is_public = false`
- `publish_plan`: publishes a hidden draft; rejects `trial`, an already-public
  plan, a retiring plan, an archived plan
- `archive_plan`: archives a drained hidden plan; rejects one with a
  subscription row, a public one, the fallback key, a named successor, `trial`
- `restore_plan`: restores; the restored row is still non-public and keeps its
  `retire_at`
- `set_plan` / `approve_plan_change`: reject an archived never-retired target

**Jest:**

- `listPlansForPlatform()` includes inactive rows and maps `active`;
  `listAllPlans()` still excludes them
- plans-tab span math counts the ghost cell; Publish/Archive visibility rules
  against each guard combination
- plan-editor create mode: key validation gates save; payload carries
  `create: true, is_public: false`

## Order of work

Server first — `upsert_plan` create mode, then the three new actions, then the
`set_plan`/`approve_plan_change` hardening, with the SQL tests as each lands,
since every client rule below is a mirror of a server guard. Then C1 (the type
and the portal listing), then C2 and C3, which are independent of each other
once C1 lands.
