-- The anon RPC surface, pinned.
--
-- WHAT THIS IS FOR. Postgres grants EXECUTE on a new function to PUBLIC by
-- default, and PUBLIC includes `anon` -- a caller with no session at all. That
-- default is how #83 shipped a `post_journal_entry` a stranger could post
-- into, and how six more functions were leaking a shop's plan, usage and
-- billing dates until 20261009000000. Both were found by someone going
-- looking. This check means the next one is found by CI instead.
--
-- WHY A PIN AND NOT A PROBE. The obvious version calls every RPC as anon and
-- looks at the status code. It is the wrong tool twice over: several of these
-- functions MUTATE -- `recompute_product_stock`, `place_storefront_order` --
-- so a probe that actually invokes them has side effects, and a 401/200 tells
-- you nothing about a function whose own body does the authorising. What
-- actually recurs is a function shipping with the DEFAULT grant nobody thought
-- about, and that is visible in the catalog without calling anything.
--
-- WHAT A FAILURE MEANS. Not "you have a vulnerability". It means the set of
-- functions reachable without a session CHANGED, and somebody has to say which
-- of the two it is:
--
--   added   -- a new function took the PUBLIC default. Almost always an
--              oversight: revoke it, or add it here with a reason.
--   removed -- a revoke landed. Good; drop the name from this list.
--
-- INCLUSION HERE IS NOT A CLAIM THAT A FUNCTION IS SAFE. This list is the
-- surface as it stands, not an audit of it. 74 names are pinned; the six that
-- 20261009000000 closed were probed by hand and the ~13 with no in-body guard
-- were read, but the rest are safe *by argument* -- a callee checks, a
-- predicate covers it -- and that is the kind of argument this codebase has
-- now got wrong four times. Narrowing this list is real work that has not been
-- done. The pin exists so it cannot get quietly WIDER while nobody is looking.
--
-- Trigger functions are excluded: PostgREST will not call them and they are
-- not reachable as RPCs, so pinning them would be noise that changes whenever
-- a trigger is added.

\set ON_ERROR_STOP on

do $$
declare
  v_expected text[] := array[
    'account_code_for_expense_category',
    'account_code_for_payment_method',
    'accounts_payable_debit',
    'backfill_missing_account',
    'backfill_shop_ledger',
    'balance_sheet',
    'can_access_location',
    'cash_flow',
    'close_accounting_period',
    'close_due_periods',
    'close_register_session',
    'customer_points_available',
    'default_chart_of_accounts',
    'default_shop_roles',
    'delete_brand',
    'delete_category',
    'delete_invoice_payment',
    'delete_or_archive_promotion',
    'delete_sale',
    'delete_tag',
    'edit_sale',
    'ensure_mobile_register',
    'get_public_delivery_areas',
    'get_public_storefront',
    'get_public_storefront_products',
    'handover_register_session',
    'has_any_shop_permission',
    'has_shop_permission',
    'is_platform_admin',
    'is_platform_admin_pending_mfa',
    'is_shop_member',
    'journal_entry_reference',
    'list_accounting_periods',
    'list_shop_staff',
    'list_shop_time_off',
    'log_recurring_bill',
    'my_location_ids',
    'my_open_session_at',
    'my_plan_change_request',
    'my_shop_member_id',
    'my_shop_permissions',
    'open_register_session',
    'opening_inventory_date',
    'opening_inventory_gap',
    'owns_shop',
    'period_exceptions',
    'place_storefront_order',
    'pos_create_customer',
    'pos_search_customers',
    'post_payroll_run',
    'receive_stock',
    'record_invoice_payment',
    'refund_sale_items',
    'register_session_counts',
    'register_session_expected',
    'rename_brand',
    'rename_category',
    'rename_tag',
    'reopen_accounting_period',
    'reserved_slugs',
    'reverse_journal_entry',
    'save_stock_count',
    'set_member_locations',
    'settle_sale_balance',
    'shop_limit',
    'shop_local_date',
    'statement_lines',
    'transfer_stock',
    'unbilled_stock_receipts',
    'unpost_payroll_run',
    'unposted_inventory_movement',
    'unposted_ledger_counts',
    'unposted_ledger_period_exposure',
    'user_has_shop_permission'
  ];
  v_actual  text[];
  v_added   text[];
  v_removed text[];
begin
  select coalesce(array_agg(distinct p.proname order by p.proname), '{}')
    into v_actual
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    join pg_type t on t.oid = p.prorettype
   where n.nspname = 'public'
     and p.prokind = 'f'
     and t.typname <> 'trigger'
     and has_function_privilege('anon', p.oid, 'EXECUTE');

  select coalesce(array_agg(x order by x), '{}') into v_added
    from unnest(v_actual) x where x <> all (v_expected);

  select coalesce(array_agg(x order by x), '{}') into v_removed
    from unnest(v_expected) x where x <> all (v_actual);

  -- Reported separately, because they are different events with different
  -- responses. A single "the list changed" would let an addition hide behind
  -- a removal in the same migration.
  if array_length(v_added, 1) is not null then
    raise exception 'FAIL: % function(s) became callable by anon and are not pinned: %. Revoke EXECUTE from PUBLIC, or add them here with a reason.',
      array_length(v_added, 1), array_to_string(v_added, ', ');
  end if;

  if array_length(v_removed, 1) is not null then
    raise exception 'FAIL: % pinned function(s) are no longer callable by anon: %. That is progress -- remove them from the list in this file.',
      array_length(v_removed, 1), array_to_string(v_removed, ', ');
  end if;

  raise notice 'ALL CHECKS PASSED: % functions reachable by anon, all pinned', array_length(v_actual, 1);
end $$;
