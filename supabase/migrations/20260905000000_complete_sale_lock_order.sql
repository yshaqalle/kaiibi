-- complete_sale and edit_sale take their row locks in a fixed order.
--
-- ## The bug
--
-- Both functions iterated the cart with no ORDER BY:
--
--   for v_item in select * from jsonb_array_elements(p_items) loop
--
-- and then took `select ... for update` on product_location_stock inside it. So
-- the locks came in CART order. Two tills ringing up the same two products in
-- opposite order take the same two locks in opposite order: one transaction
-- holds A wanting B while the other holds B wanting A, and Postgres resolves it
-- by killing one of them. The cashier sees a failed sale, on a busy shop floor,
-- for a reason they cannot act on.
--
-- Both are fixed together because they lock the same rows. Fixing only
-- complete_sale would leave an edit able to deadlock against a sale, which is
-- the same bug with a rarer trigger.
--
-- ## Why these were the odd ones out
--
-- Every other RPC that locks stock rows already orders its loop, and each says
-- why. receive_stock:131 puts it plainly:
--
--   "Ordered by product id so two concurrent receipts touching the same
--    products take their row locks in the same order and cannot deadlock --
--    the same reason transfer_stock and refund_sale_items order their loops."
--
-- transfer_stock:145 and save_stock_count:189 carry the same note.
-- refund_sale_items:148 orders by sale_item_id. The two on the hottest path,
-- running more often than the other four combined, were the ones without it.
--
-- ## Why ordinality is the tiebreaker
--
-- `(value->>'product_id')` alone is not a total order: a cart can list the same
-- product twice, which is ordinary when a cashier scans an item a second time.
-- Ties would then break arbitrarily. Array position keeps those lines in the
-- order they were rung -- the same reasoning and the same expression
-- receive_stock uses.
--
-- ## Why this ships on its own
--
-- It is a live bug today, independent of anything else. It is also a
-- prerequisite for FIFO cost layers, which make it much likelier to fire: every
-- line goes from locking one row to locking that plus every cost layer it
-- consumes, and holds them longer. Fixing it first lets that phase be judged on
-- its own merits rather than on a deadlock it inherited.

do $$
declare
  v_needle constant text := 'for v_item in select * from jsonb_array_elements(p_items) loop';
  -- Ordered by product id so two concurrent sales touching the same products
  -- take their row locks in the same order and cannot deadlock. Ordinality is
  -- the tiebreaker -- see the header.
  v_fixed  constant text := 'for v_item in select value from jsonb_array_elements(p_items) with ordinality as t(value, ord) order by (value->>''product_id''), ord loop';
  v_fn     record;
  v_src    text;
  v_hits   integer;
begin
  -- Rewritten by text substitution rather than by pasting ~900 lines of two
  -- functions into this file.
  --
  -- Deliberate, and the safer of the two options at this size. A verbatim paste
  -- of functions this long is a diff nobody can read, and the next person to
  -- change either would have two near-identical copies to reconcile. This
  -- states the edit itself: find the unordered loop header, add the ORDER BY,
  -- and refuse to run unless each function has exactly one.
  --
  -- The count is the safety. If a later migration has already touched those
  -- lines, this raises rather than silently applying to the wrong number.
  for v_fn in
    select p.oid,
           p.proname,
           -- pg_get_function_ARGUMENTS, not _identity_arguments: the identity
           -- form drops the DEFAULT clauses, and CREATE OR REPLACE refuses to
           -- remove defaults from an existing function.
           pg_get_function_arguments(p.oid) as args,
           pg_get_function_result(p.oid)             as result,
           p.prosrc
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname in ('complete_sale', 'edit_sale')
  loop
    v_src := v_fn.prosrc;
    v_hits := (length(v_src) - length(replace(v_src, v_needle, ''))) / length(v_needle);

    if v_hits <> 1 then
      raise exception
        'expected exactly 1 unordered item loop in %, found % -- the function has changed and this migration needs rewriting',
        v_fn.proname, v_hits;
    end if;

    execute format(
      'create or replace function public.%I(%s) returns %s language plpgsql security definer set search_path = public as %L',
      v_fn.proname,
      v_fn.args,
      v_fn.result,
      replace(v_src, v_needle, v_fixed)
    );
  end loop;
end $$;
