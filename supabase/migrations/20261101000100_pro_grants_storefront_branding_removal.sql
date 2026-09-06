-- Branding removal is granted through the MODULE catalog
-- (storefront_branding_removal, src/lib/entitlements.ts), not a bespoke
-- boolean column on plans. A column cannot survive plan succession: when a
-- plan retires and shop_effective_plan() hops a shop to its successor
-- (20260824000100), the hop carries the successor's OWN column value, not
-- the retired plan's -- and a freshly-created successor row defaults to
-- false, so every paying shop on it would silently get the mark back. A
-- module survives the same hop for free, because shop_has_module() resolves
-- through shop_effective_plan() and reads whichever plan row is current.
--
-- A module also gets the operator control and per-shop override a column
-- never had: the Plans tab already writes `modules`, and
-- shop_entitlement_overrides already lets one shop be granted (or denied)
-- a module without touching its plan. Neither exists for a one-off column.
--
-- `array_append` under a "not already granted" guard, the same idiom
-- 20260923000000_storefront_module_grant.sql uses for `storefront`: correct
-- on a fresh database (seed and this migration run back to back) and
-- idempotent if re-applied.
update public.plans
set modules = array_append(modules, 'storefront_branding_removal')
where key = 'pro'
  and not ('storefront_branding_removal' = any(modules));
