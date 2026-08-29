-- Narrow the anon RPC surface to the four functions that belong on it.
--
-- The follow-up 20261009000000 named and left undone: that migration closed
-- six leaking functions and pinned the rest, saying out loud that the rest
-- were "safe by argument -- the kind of argument this codebase has now got
-- wrong four times", and that narrowing the list was real work nobody had
-- done. This is that work.
--
-- WHAT anon COULD REACH, AND WHY IT IS SPRAWL NOT DESIGN. Postgres grants
-- EXECUTE on every new function to PUBLIC by default, and PUBLIC includes the
-- PostgREST `anon` role -- an unauthenticated HTTP caller. 80 public functions
-- were anon-executable. Exactly four of them carry a DELIBERATE, explicit anon
-- grant, because a logged-out customer browsing a shop's storefront calls
-- them: get_public_storefront, get_public_storefront_products,
-- get_public_delivery_areas, place_storefront_order. The other 76 were
-- anon-executable only through the default nobody chose. Six were revoked in
-- 20261009000000; this revokes the remaining 70.
--
-- THE MEASUREMENT THAT MAKES THIS SAFE, not the argument. `anon` holds ZERO
-- table and view privileges in this database -- `has_table_privilege('anon',
-- <any table>, 'SELECT')` is false everywhere, checked three ways. That single
-- fact collapses the whole risk model this codebase kept getting wrong:
--
--   * A function used inside an RLS policy does NOT need anon execute. RLS is
--     evaluated as the INVOKING role, and anon can invoke nothing against a
--     table it cannot touch -- so has_shop_permission, is_shop_member, owns_shop
--     and the rest are only ever evaluated for `authenticated`, or inside a
--     SECURITY DEFINER function running as the owner. Revoking anon leaves both
--     paths intact.
--   * A function used inside a view does NOT need anon execute, for the same
--     reason: anon holds no grant on any view.
--   * A function called by a SECURITY DEFINER function does NOT need anon
--     execute: that caller runs as the owner, and grants do not gate the owner.
--
-- The remaining question -- is any of the 70 called by the CLIENT before a
-- session exists (a pre-auth flow a measurement cannot see) -- was answered by
-- reading all 70 definitions and their callers, then adversarially: seven
-- independent passes tried to REFUTE "safe to revoke anon" for each, and a
-- completeness critic mapped the entire pre-authentication surface (the
-- `(public)` route group makes zero RPC calls; the customer storefront route
-- reaches only the four kept-public functions; every other RPC wrapper lives
-- in an `(admin)` / `platform` module behind a session). None of the 70 has an
-- anonymous caller. That is recorded because "safe by argument" is what failed
-- before -- this time the argument was attacked rather than asserted.
--
-- THE INVARIANT. Each statement below is `revoke from public; grant to
-- authenticated, service_role`. Every one of these functions is ALREADY
-- callable by `authenticated` today (PUBLIC includes it), so this migration
-- ONLY removes anon -- it never makes a function callable by anyone who could
-- not already call it. service_role is granted too because some of these
-- reached it only through the same PUBLIC default (recompute_product_stock was
-- one), and a server-side path must not break; service_role is trusted
-- infrastructure for which broad EXECUTE is correct.
--
-- After this and 20261009000000, exactly four functions are anon-executable,
-- and verify-anon-rpc-surface.sql pins that set at four.

revoke execute on function public.account_code_for_expense_category(p_category text) from public;
grant execute on function public.account_code_for_expense_category(p_category text) to authenticated, service_role;

revoke execute on function public.account_code_for_payment_method(p_method text) from public;
grant execute on function public.account_code_for_payment_method(p_method text) to authenticated, service_role;

revoke execute on function public.accounts_payable_debit(p_shop_id uuid) from public;
grant execute on function public.accounts_payable_debit(p_shop_id uuid) to authenticated, service_role;

revoke execute on function public.backfill_missing_account(p_code text, p_source text) from public;
grant execute on function public.backfill_missing_account(p_code text, p_source text) to authenticated, service_role;

revoke execute on function public.backfill_shop_ledger(p_shop_id uuid) from public;
grant execute on function public.backfill_shop_ledger(p_shop_id uuid) to authenticated, service_role;

revoke execute on function public.balance_sheet(p_shop_id uuid, p_as_of date) from public;
grant execute on function public.balance_sheet(p_shop_id uuid, p_as_of date) to authenticated, service_role;

revoke execute on function public.can_access_location(p_location_id uuid) from public;
grant execute on function public.can_access_location(p_location_id uuid) to authenticated, service_role;

revoke execute on function public.cash_flow(p_shop_id uuid, p_from date, p_to date) from public;
grant execute on function public.cash_flow(p_shop_id uuid, p_from date, p_to date) to authenticated, service_role;

revoke execute on function public.close_accounting_period(p_shop_id uuid, p_period_id uuid, p_force boolean) from public;
grant execute on function public.close_accounting_period(p_shop_id uuid, p_period_id uuid, p_force boolean) to authenticated, service_role;

revoke execute on function public.close_due_periods(p_shop_id uuid) from public;
grant execute on function public.close_due_periods(p_shop_id uuid) to authenticated, service_role;

revoke execute on function public.close_register_session(p_session_id uuid, p_cash jsonb, p_note text) from public;
grant execute on function public.close_register_session(p_session_id uuid, p_cash jsonb, p_note text) to authenticated, service_role;

revoke execute on function public.customer_points_available(p_customer_id uuid) from public;
grant execute on function public.customer_points_available(p_customer_id uuid) to authenticated, service_role;

revoke execute on function public.default_chart_of_accounts() from public;
grant execute on function public.default_chart_of_accounts() to authenticated, service_role;

revoke execute on function public.default_shop_roles() from public;
grant execute on function public.default_shop_roles() to authenticated, service_role;

revoke execute on function public.delete_brand(p_shop_id uuid, p_name text) from public;
grant execute on function public.delete_brand(p_shop_id uuid, p_name text) to authenticated, service_role;

revoke execute on function public.delete_category(p_shop_id uuid, p_name text) from public;
grant execute on function public.delete_category(p_shop_id uuid, p_name text) to authenticated, service_role;

revoke execute on function public.delete_invoice_payment(p_payment_id uuid) from public;
grant execute on function public.delete_invoice_payment(p_payment_id uuid) to authenticated, service_role;

revoke execute on function public.delete_or_archive_promotion(p_id uuid) from public;
grant execute on function public.delete_or_archive_promotion(p_id uuid) to authenticated, service_role;

revoke execute on function public.delete_sale(p_sale_id uuid) from public;
grant execute on function public.delete_sale(p_sale_id uuid) to authenticated, service_role;

revoke execute on function public.delete_tag(p_shop_id uuid, p_name text) from public;
grant execute on function public.delete_tag(p_shop_id uuid, p_name text) to authenticated, service_role;

revoke execute on function public.edit_sale(p_sale_id uuid, p_items jsonb, p_payments jsonb, p_customer_name text, p_customer_phone text, p_customer_email text, p_discount_cents integer, p_customer_id uuid, p_allow_balance boolean) from public;
grant execute on function public.edit_sale(p_sale_id uuid, p_items jsonb, p_payments jsonb, p_customer_name text, p_customer_phone text, p_customer_email text, p_discount_cents integer, p_customer_id uuid, p_allow_balance boolean) to authenticated, service_role;

revoke execute on function public.ensure_mobile_register(p_shop_id uuid, p_location_id uuid, p_shop_member_id uuid) from public;
grant execute on function public.ensure_mobile_register(p_shop_id uuid, p_location_id uuid, p_shop_member_id uuid) to authenticated, service_role;

revoke execute on function public.handover_register_session(p_session_id uuid, p_incoming_member_id uuid, p_cash jsonb, p_note text) from public;
grant execute on function public.handover_register_session(p_session_id uuid, p_incoming_member_id uuid, p_cash jsonb, p_note text) to authenticated, service_role;

revoke execute on function public.has_any_shop_permission(p_shop_id uuid, p_permissions text[]) from public;
grant execute on function public.has_any_shop_permission(p_shop_id uuid, p_permissions text[]) to authenticated, service_role;

revoke execute on function public.has_shop_permission(p_shop_id uuid, p_permission text) from public;
grant execute on function public.has_shop_permission(p_shop_id uuid, p_permission text) to authenticated, service_role;

revoke execute on function public.is_platform_admin() from public;
grant execute on function public.is_platform_admin() to authenticated, service_role;

revoke execute on function public.is_platform_admin_pending_mfa() from public;
grant execute on function public.is_platform_admin_pending_mfa() to authenticated, service_role;

revoke execute on function public.is_shop_member(p_shop_id uuid) from public;
grant execute on function public.is_shop_member(p_shop_id uuid) to authenticated, service_role;

revoke execute on function public.journal_entry_reference(p_year text, p_number integer) from public;
grant execute on function public.journal_entry_reference(p_year text, p_number integer) to authenticated, service_role;

revoke execute on function public.list_accounting_periods(p_shop_id uuid) from public;
grant execute on function public.list_accounting_periods(p_shop_id uuid) to authenticated, service_role;

revoke execute on function public.list_shop_staff(p_shop_id uuid) from public;
grant execute on function public.list_shop_staff(p_shop_id uuid) to authenticated, service_role;

revoke execute on function public.list_shop_time_off(p_shop_id uuid, p_start_date date, p_end_date date) from public;
grant execute on function public.list_shop_time_off(p_shop_id uuid, p_start_date date, p_end_date date) to authenticated, service_role;

revoke execute on function public.log_recurring_bill(p_bill_id uuid, p_occurred_on date) from public;
grant execute on function public.log_recurring_bill(p_bill_id uuid, p_occurred_on date) to authenticated, service_role;

revoke execute on function public.my_location_ids(p_shop_id uuid) from public;
grant execute on function public.my_location_ids(p_shop_id uuid) to authenticated, service_role;

revoke execute on function public.my_open_session_at(p_location_id uuid) from public;
grant execute on function public.my_open_session_at(p_location_id uuid) to authenticated, service_role;

revoke execute on function public.my_plan_change_request(p_shop_id uuid) from public;
grant execute on function public.my_plan_change_request(p_shop_id uuid) to authenticated, service_role;

revoke execute on function public.my_shop_member_id(p_shop_id uuid) from public;
grant execute on function public.my_shop_member_id(p_shop_id uuid) to authenticated, service_role;

revoke execute on function public.my_shop_permissions(p_shop_id uuid) from public;
grant execute on function public.my_shop_permissions(p_shop_id uuid) to authenticated, service_role;

revoke execute on function public.open_register_session(p_register_id uuid, p_shop_member_id uuid, p_cash jsonb, p_note text) from public;
grant execute on function public.open_register_session(p_register_id uuid, p_shop_member_id uuid, p_cash jsonb, p_note text) to authenticated, service_role;

revoke execute on function public.opening_inventory_date(p_shop_id uuid) from public;
grant execute on function public.opening_inventory_date(p_shop_id uuid) to authenticated, service_role;

revoke execute on function public.opening_inventory_gap(p_shop_id uuid) from public;
grant execute on function public.opening_inventory_gap(p_shop_id uuid) to authenticated, service_role;

revoke execute on function public.owns_shop(p_shop_id uuid) from public;
grant execute on function public.owns_shop(p_shop_id uuid) to authenticated, service_role;

revoke execute on function public.period_exceptions(p_shop_id uuid, p_period_id uuid) from public;
grant execute on function public.period_exceptions(p_shop_id uuid, p_period_id uuid) to authenticated, service_role;

revoke execute on function public.pos_create_customer(p_shop_id uuid, p_first_name text, p_last_name text, p_phone text, p_email text) from public;
grant execute on function public.pos_create_customer(p_shop_id uuid, p_first_name text, p_last_name text, p_phone text, p_email text) to authenticated, service_role;

revoke execute on function public.pos_search_customers(p_shop_id uuid, p_query text) from public;
grant execute on function public.pos_search_customers(p_shop_id uuid, p_query text) to authenticated, service_role;

revoke execute on function public.post_payroll_run(p_run_id uuid) from public;
grant execute on function public.post_payroll_run(p_run_id uuid) to authenticated, service_role;

revoke execute on function public.receive_stock(p_shop_id uuid, p_location_id uuid, p_items jsonb, p_supplier_name text, p_reference text, p_note text) from public;
grant execute on function public.receive_stock(p_shop_id uuid, p_location_id uuid, p_items jsonb, p_supplier_name text, p_reference text, p_note text) to authenticated, service_role;

revoke execute on function public.record_invoice_payment(p_invoice_id uuid, p_amount_cents integer, p_paid_on date, p_method text, p_note text) from public;
grant execute on function public.record_invoice_payment(p_invoice_id uuid, p_amount_cents integer, p_paid_on date, p_method text, p_note text) to authenticated, service_role;

revoke execute on function public.refund_sale_items(p_sale_id uuid, p_items jsonb) from public;
grant execute on function public.refund_sale_items(p_sale_id uuid, p_items jsonb) to authenticated, service_role;

revoke execute on function public.register_session_counts(p_shop_id uuid) from public;
grant execute on function public.register_session_counts(p_shop_id uuid) to authenticated, service_role;

revoke execute on function public.register_session_expected(p_session_id uuid) from public;
grant execute on function public.register_session_expected(p_session_id uuid) to authenticated, service_role;

revoke execute on function public.rename_brand(p_shop_id uuid, p_old_name text, p_new_name text) from public;
grant execute on function public.rename_brand(p_shop_id uuid, p_old_name text, p_new_name text) to authenticated, service_role;

revoke execute on function public.rename_category(p_shop_id uuid, p_old_name text, p_new_name text) from public;
grant execute on function public.rename_category(p_shop_id uuid, p_old_name text, p_new_name text) to authenticated, service_role;

revoke execute on function public.rename_tag(p_shop_id uuid, p_old_name text, p_new_name text) from public;
grant execute on function public.rename_tag(p_shop_id uuid, p_old_name text, p_new_name text) to authenticated, service_role;

revoke execute on function public.reopen_accounting_period(p_shop_id uuid, p_period_id uuid, p_reason text) from public;
grant execute on function public.reopen_accounting_period(p_shop_id uuid, p_period_id uuid, p_reason text) to authenticated, service_role;

revoke execute on function public.reserved_slugs() from public;
grant execute on function public.reserved_slugs() to authenticated, service_role;

revoke execute on function public.reverse_journal_entry(p_entry_id uuid, p_reason text) from public;
grant execute on function public.reverse_journal_entry(p_entry_id uuid, p_reason text) to authenticated, service_role;

revoke execute on function public.save_stock_count(p_shop_id uuid, p_location_id uuid, p_items jsonb, p_note text) from public;
grant execute on function public.save_stock_count(p_shop_id uuid, p_location_id uuid, p_items jsonb, p_note text) to authenticated, service_role;

revoke execute on function public.set_member_locations(p_member_id uuid, p_location_ids uuid[]) from public;
grant execute on function public.set_member_locations(p_member_id uuid, p_location_ids uuid[]) to authenticated, service_role;

revoke execute on function public.settle_sale_balance(p_sale_id uuid, p_payments jsonb, p_register_session_id uuid) from public;
grant execute on function public.settle_sale_balance(p_sale_id uuid, p_payments jsonb, p_register_session_id uuid) to authenticated, service_role;

revoke execute on function public.shop_limit(p_shop_id uuid, p_resource text) from public;
grant execute on function public.shop_limit(p_shop_id uuid, p_resource text) to authenticated, service_role;

revoke execute on function public.shop_local_date(p_at timestamp with time zone) from public;
grant execute on function public.shop_local_date(p_at timestamp with time zone) to authenticated, service_role;

revoke execute on function public.statement_lines(p_shop_id uuid, p_from date, p_to date, p_detail boolean) from public;
grant execute on function public.statement_lines(p_shop_id uuid, p_from date, p_to date, p_detail boolean) to authenticated, service_role;

revoke execute on function public.transfer_stock(p_shop_id uuid, p_from_location_id uuid, p_to_location_id uuid, p_items jsonb, p_note text) from public;
grant execute on function public.transfer_stock(p_shop_id uuid, p_from_location_id uuid, p_to_location_id uuid, p_items jsonb, p_note text) to authenticated, service_role;

revoke execute on function public.unbilled_stock_receipts(p_shop_id uuid, p_limit integer, p_search text) from public;
grant execute on function public.unbilled_stock_receipts(p_shop_id uuid, p_limit integer, p_search text) to authenticated, service_role;

revoke execute on function public.unpost_payroll_run(p_run_id uuid) from public;
grant execute on function public.unpost_payroll_run(p_run_id uuid) to authenticated, service_role;

revoke execute on function public.unposted_inventory_movement(p_shop_id uuid) from public;
grant execute on function public.unposted_inventory_movement(p_shop_id uuid) to authenticated, service_role;

revoke execute on function public.unposted_ledger_counts(p_shop_id uuid) from public;
grant execute on function public.unposted_ledger_counts(p_shop_id uuid) to authenticated, service_role;

revoke execute on function public.unposted_ledger_period_exposure(p_shop_id uuid) from public;
grant execute on function public.unposted_ledger_period_exposure(p_shop_id uuid) to authenticated, service_role;

revoke execute on function public.user_has_shop_permission(p_user_id uuid, p_shop_id uuid, p_permission text) from public;
grant execute on function public.user_has_shop_permission(p_user_id uuid, p_shop_id uuid, p_permission text) to authenticated, service_role;

-- 70 functions revoked from anon; four deliberate public reads remain.
