-- The ZAAD and e-Dahab merchant numbers a receipt prints under its payment
-- lines, so a customer can see which account took their money -- and query it
-- with the carrier if it didn't arrive.
--
-- PER STORE, not per business, and that split is the point:
--
--   `shops.payment_zaad_enabled` / `payment_edahab_enabled` stay where they are
--   and keep meaning "does this business accept ZAAD at all" -- a commercial
--   decision, made once. The number below is "which till at this branch
--   receives it" -- a physical fact about a counter, the same shape as the
--   opening hours, contact phone and scanner flags already on this table. A
--   business with three branches commonly runs three merchant accounts, and a
--   shop-wide column would print the wrong one on two of them.
--
-- Free text rather than a checked format: these are carrier-issued and their
-- shape is the carrier's to change. A regex here would eventually reject a
-- number a shop was actually given, and a receipt that refuses to print a valid
-- merchant id is worse than one that prints whatever the owner typed.
--
-- Nullable with no default: a shop that hasn't entered one prints no merchant
-- line at all, which is correct. An empty string and a null both mean "not
-- set", and readers treat them the same, so nothing has to be backfilled.

alter table public.shop_locations
  add column if not exists zaad_merchant_id text;

alter table public.shop_locations
  add column if not exists edahab_merchant_id text;

comment on column public.shop_locations.zaad_merchant_id is
  'ZAAD merchant number for this store, printed on receipts under a ZAAD payment line. Null when unset.';
comment on column public.shop_locations.edahab_merchant_id is
  'e-Dahab merchant number for this store, printed on receipts under an e-Dahab payment line. Null when unset.';
