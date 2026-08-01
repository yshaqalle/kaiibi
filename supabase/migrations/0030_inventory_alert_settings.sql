-- Inventory alert settings — Settings → Inventory alerts.
-- `default_low_stock_level` replaces the previous hardcoded fallback of 5
-- used when a product has no per-product `reorder_level` set — read by
-- getLowStockProducts/product-tile.tsx/product-table-row.tsx/inventory.tsx
-- (src/lib/products.ts).
-- `expiry_tracking_enabled`/`expiry_warning_lead_days` drive
-- getExpiringProducts (src/lib/products.ts) — only ever applies to products
-- that already have their own `expiry_date` filled in; products with no
-- expiry date set are never flagged.
alter table public.shops add column if not exists default_low_stock_level integer not null default 5
  check (default_low_stock_level >= 0);
alter table public.shops add column if not exists expiry_tracking_enabled boolean not null default false;
alter table public.shops add column if not exists expiry_warning_lead_days integer not null default 30
  check (expiry_warning_lead_days >= 0);
