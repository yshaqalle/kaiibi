# Monetization — implementation plan

**Design:** `docs/superpowers/specs/2026-08-04-monetization-design.md`
**Status:** Complete

Six migrations, `20260818000000`–`20260818000500`, plus the client and portal.
Each step was independently shippable and left the app working.

## 1. Plans and subscriptions — `20260818000000`

`platform_settings` (singleton: trial days, grace days, post-trial plan key),
`plans`, `shop_subscriptions` (unique per shop), `shop_entitlement_overrides`,
`subscription_payments`. Seeds four plans: `trial`, `free`, `standard`, `pro`.

RLS: shop members `select` their own rows; `plans` and `platform_settings`
readable by any authenticated user (the upgrade screen needs them). **No
insert/update/delete policy for anyone** — every write goes through a
service-role edge function. That is the whole security posture in one sentence.

## 2. Trial provisioning — `20260818000100`

`AFTER INSERT ON shops` → a `trial` subscription, `security definer` because
`shop_subscriptions` has no insert policy. Backfills every existing shop with a
trial dated from `now()`, not from `created_at` — dating it from creation would
expire every long-standing customer the moment the migration landed.

## 3. Entitlement resolution — `20260818000200`

`shop_effective_status`, `shop_effective_plan`, `shop_has_module`, `shop_limit`,
`my_shop_entitlements`. All `security definer stable`, mirroring
`has_shop_permission()`'s shape so they are safe to call from a policy.

Fails closed: a shop with no subscription row resolves to Free, never to
"everything".

## 4. Usage counters and limits — `20260818000300`

`shop_usage_counters` plus a generic `enforce_shop_limit()` `BEFORE INSERT`
trigger taking its resource from `TG_ARGV[0]`, attached to `shop_locations`,
`products`, `shop_members`, `customers`, `vendors`. `sales_per_month` is a
windowed count rather than a counter, being a rolling window and not a stock.

Reproduces `my_shop_entitlements()` whole to add `usage`, per the convention in
`0024_permission_gates.sql:240-259`.

## 5. Module write-gates — `20260818000400`

`enforce_shop_module()` on INSERT and UPDATE only, per the table→module map in
the design. Deletes and refunds deliberately ungated.

`shop_locations` is capped by the `locations` *limit* rather than gated by the
`multi_location` module — every shop has one store and must always be able to
edit it. `shop_member_locations` is ungated entirely: assigning a member to the
single store is normal single-store behaviour.

## 6. Platform admins — `20260818000500`

`platform_admins`, `platform_audit_log`, `is_platform_admin()` (requires
`aal2`), `is_platform_admin_pending_mfa()` (for the sign-in screen only, grants
nothing), and the `operators read *` policies. TOTP enabled in `config.toml`.

No operator is seeded — the first is appointed by hand.

## Client

- `src/lib/entitlements.ts` — pure catalog, `moduleForPath`, `isAtLimit`,
  `headroom`, `describePlanError`. 40 unit tests.
- `src/lib/subscriptions.ts`, `src/lib/platform.ts` — the async halves.
- `src/hooks/use-auth.tsx` — `entitlements` joins the existing
  `Promise.allSettled` so it lands under the same `shopSeq` guard as
  permissions. Fails closed to Free.
- `src/app/(admin)/_layout.tsx` — module check after the permission check, so
  someone whose role doesn't grant a screen is told that rather than sold an
  upgrade. Renders an upgrade wall in place rather than redirecting, which would
  loop when the un-entitled route is the landing tab.
- Nav: tabs lock rather than hide, in all three hand-synced nav files.
- Action gates on Add store, Add product, and the staff seat check in
  `provision-staff`; CSV import gets a headroom pre-flight so a 400-row file
  reports "12 fit" rather than one opaque failure.
- `src/components/settings/panels/billing-panel.tsx`, ungated by permission or
  module — it is the one screen that explains why something else is locked.
- `src/app/(platform)/` — web-only portal with an MFA challenge, shops list,
  shop detail with actions, plans, audit log and operators.

## Verification

- `supabase db reset` from scratch, then all three SQL suites:
  `verify-entitlements.sql` (12 groups), `verify-platform-portal.sql` (6 groups),
  and the existing `verify-accounting-writes.sql`.
- `npm test` — 426 tests, 22 suites.
- Concurrency proven by hand: two `psql` sessions inserting the boundary-th
  product simultaneously; one wins, one gets `limit_reached`, counter matches.
- Module gate proven through the RPC path: `transfer_stock` succeeds on Pro,
  refused on Standard from inside the security-definer function, stock unmoved.

## Incidental fix

`verify-accounting-writes.sql` had been failing since `730efaf` made
`shifts.location_id` NOT NULL without updating the script. Repaired here so the
suite runs green.
