-- Grants the `storefront` module (added to the catalog in
-- src/lib/entitlements.ts) to the two plans it belongs on: `trial`, so an
-- evaluating shop sees the whole product, and `pro`, the tier a public page
-- is packaged into. `free` and `standard` do not get it -- a public page is
-- part of what moving up from Standard buys.
--
-- A fresh migration rather than an edit to 20260818000000's seed: that seed
-- already ran in every environment that has this schema, and its `insert ...
-- on conflict do nothing` would make an edit to it silently do nothing there.
-- `array_append` under a "not already granted" guard keeps this both correct
-- on a fresh database (where the seed and this migration run back to back)
-- and idempotent if re-applied.

update public.plans
set modules = array_append(modules, 'storefront')
where key in ('trial', 'pro')
  and not ('storefront' = any(modules));
