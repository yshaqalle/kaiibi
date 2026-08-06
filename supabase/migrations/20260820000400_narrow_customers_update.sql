-- Narrow "update customers" to customers.edit alone.
--
-- The policy this replaces (20260801221945_check_customer_rpc.sql:163-166)
-- also granted UPDATE to anyone holding pos.access or sales.edit:
--
--   using (has_any_shop_permission(shop_id, ARRAY['customers.edit', 'pos.access', 'sales.edit']))
--   with check (has_any_shop_permission(shop_id, ARRAY['customers.edit', 'pos.access', 'sales.edit']))
--
-- Neither of the extra permissions is exercised by anything that writes
-- through the client's RLS-checked path, so they were pure exposure:
--
--   1. The ONLY client-side UPDATE on public.customers is updateCustomer in
--      src/lib/customers.ts:126, called from exactly three places, all in
--      src/app/(admin)/(tabs)/people.tsx (the edit modal ~:438, the VIP
--      toggle ~:487, the notes save ~:536). POS never calls it.
--   2. customers.points_balance is maintained by
--      apply_points_ledger_delta(), a `security definer` trigger
--      (20260820000000_customer_loyalty_points.sql:209-218) that writes
--      through its own privileges, not the caller's RLS.
--   3. rename_tag / delete_tag update customers.tags inside `security
--      definer` functions with their own permission checks
--      (0024_permission_gates.sql:612-640) -- also unaffected.
--
-- So pos.access and sales.edit were granting an UPDATE ability nothing in
-- the app used, while letting anyone with till access rewrite a customer's
-- name, phone, tags or notes directly through the API. Re-verify the three
-- points above (grep the call sites) before assuming this is still safe --
-- this migration only records that it was true as of 20260820000300.
--
-- insert customers and read customers are untouched: POS legitimately
-- creates and reads customers, only UPDATE is being narrowed.

drop policy "update customers" on "public"."customers";

create policy "update customers"
on "public"."customers"
as permissive
for update
to public
using (public.has_any_shop_permission(shop_id, ARRAY['customers.edit'::text]))
with check (public.has_any_shop_permission(shop_id, ARRAY['customers.edit'::text]));
