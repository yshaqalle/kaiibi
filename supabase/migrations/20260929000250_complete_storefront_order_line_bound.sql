-- AN ORDER LINE THE TILL CANNOT CARRY IS REFUSED IN THE SHOP'S OWN WORDS.
--
-- 20260929000200 made complete_storefront_order send every line to
-- complete_sale as `agreed_unit_price_cents`, which is the whole of how a
-- fulfilment charges the price the customer was quoted. It also put every such
-- line behind that field's own per-line ceiling (20260929000050):
--
--   agreed price for % is out of range: % x % is more than the % cents one
--   line may carry
--
-- ...and complete_storefront_order maps none of it. Every other refusal this
-- function can meet comes back as a snake_case code with a JSON detail, which
-- orderErrorMessage (src/lib/storefront-admin.ts) turns into a sentence a
-- shopkeeper can act on. This one falls through `else raise;` to
-- orderErrorMessage's `default: return null`, and complete_sale's raw English
-- -- naming a field no storefront screen has ever shown -- lands on the shop's
-- screen verbatim.
--
-- IT IS REACHABLE, AND IT IS A REGRESSION. order_items.line_total_cents is a
-- plain `integer` (20260926000050), so a line of 2 at 600,000,000 is storable
-- and, before this branch, completable: complete_sale priced it from
-- products.price_cents and the only bound it met was int32. Filing it at the
-- agreed price puts it under 1,000,000,000 instead, which is a distrust of a
-- caller's number and belongs where one arrives (20260929000050's header) --
-- but the customer's own order is now such a caller, and it deserves the same
-- treatment every other refusal on this path gets.
--
-- So: a typed `order_line_out_of_range`, carrying complete_sale's message in
-- its detail the way `insufficient_stock` carries its own, and one sentence at
-- the other end. NOTHING ABOUT THE BOUND ITSELF MOVES -- it is complete_sale's
-- and it stays complete_sale's; this migration only gives the refusal a
-- translation. Check 53 in verify-order-transitions.sql is the reproduction.
--
-- ── ALSO HERE: WHY lines_cents IS IN THE DETAIL ───────────────────────────
--
-- `order_total_changed` carries `quoted_cents` and `lines_cents` and no client
-- reads either -- orderErrorMessage switches on the code alone. That was
-- raised as dead weight and it is kept deliberately, now said out loud in the
-- declaration: since 20260929000200 that branch fires ONLY for an order row
-- that disagrees with its own lines, which no shipped writer can produce, so
-- whoever meets it is reading a log or a support ticket rather than a screen,
-- and the two figures are the entire disagreement at the moment it happened.
--
-- ── COPIED FORWARD ────────────────────────────────────────────────────────
--
-- complete_storefront_order is reproduced IN FULL, per this repo's convention
-- (20260908000150's header), from
-- 20260929000200_complete_storefront_order_agreed.sql -- its newest definition
-- -- by textual substitution against that file rather than retyped, with the
-- two changes above and NOTHING ELSE. Task 4's four load-bearing edits (the
-- fulfilment mark, `agreed_unit_price_cents` in the payload,
-- `p_prices_include_tax => true`, and the DELETE that takes the mark back
-- down) are unchanged and are now guarded, entry by entry, in
-- supabase/tests/accumulated-rpc-edits.test.ts -- which this migration is the
-- first copy-forward to be read by.
--
-- complete_sale is NOT reproduced here: it is untouched, and its newest
-- definition stays 20260929000200's. The undercut gate, its storefront
-- exemption, the agreed-price/promotion refusal and both bounds are all in
-- that function and none of them moves.
--
-- THE SIGNATURE DOES NOT CHANGE, so this is a plain `create or replace` with
-- no drop and the existing ACLs survive. The revoke/grant pair at the foot
-- restates rather than repairs -- written anyway, in the revoke-then-grant
-- order, because `grant execute` alone is a no-op against Postgres's default
-- EXECUTE-to-PUBLIC and a reader must not have to know which migrations
-- dropped and which replaced to know who may call this.

create or replace function public.complete_storefront_order(
  p_order_id       uuid,
  p_payment_method text
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_order      public.orders%rowtype;
  v_items      jsonb;
  v_sale_id    uuid;
  v_location   uuid;
  v_entry_date date;
  v_missing    text;
  v_msg        text;
  v_fee_entry_id uuid;
  -- What this order's own LINES come to, read back only when the payment this
  -- function tendered failed to equal the total complete_sale computed from
  -- them. See the order_total_changed branch for what that can still mean.
  --
  -- NO CLIENT READS IT, AND THAT IS THE POINT OF IT. orderErrorMessage
  -- (storefront-admin.ts) translates `order_total_changed` into one sentence
  -- and reads only the code; `quoted_cents` and `lines_cents` are for whoever
  -- has to DIAGNOSE one. This branch is now reachable only when an order row
  -- disagrees with its own lines -- a direct database edit, a restore, or a
  -- future writer -- so the person reading it is reading a log or a support
  -- ticket, and the two figures are the whole of the disagreement. Deriving
  -- them afterwards means a query against rows that may have moved since.
  v_lines_cents bigint;
begin
  -- FOR UPDATE, so two shop phones tapping "Handed over" at the same moment
  -- queue instead of both reading 'ready' and both posting a sale. The second
  -- one wakes up, re-reads 'completed', and is refused by the status guard
  -- below.
  select * into v_order from public.orders where id = p_order_id for update;
  if v_order.id is null then
    raise exception 'order % not found', p_order_id;
  end if;

  if not public.is_shop_member(v_order.shop_id) then
    raise exception 'not authorized for order %', p_order_id;
  end if;
  if not public.shop_has_module(v_order.shop_id, 'storefront') then
    raise exception 'module_not_included'
      using errcode = 'P0001',
            detail = json_build_object('module', 'storefront')::text,
            hint = 'Upgrade the plan to make changes here.';
  end if;

  -- The new check: a shop member who cannot ring up a sale at the counter
  -- cannot ring one up through the storefront either -- complete_sale's own
  -- rule (its header, point 3), stated here as a typed refusal instead of
  -- being discovered three calls deep. Checked before the payment-method
  -- validation below: a member with no till access is refused for that
  -- reason regardless of what they tapped for "paid with".
  if not public.has_shop_permission(v_order.shop_id, 'pos.access') then
    raise exception 'pos_access_required' using errcode = 'P0001';
  end if;

  -- Checked here rather than left to complete_sale's own payment-method
  -- validation, because getting this wrong must not cost a stock decrement
  -- and a journal reference first. The list is complete_sale's list
  -- (20260908000300:233) minus 'unpaid': an order handed over at the door has
  -- been paid for, and this function has no customer record to leave a
  -- balance against.
  if p_payment_method is null or p_payment_method not in ('cash', 'zaad', 'edahab', 'other') then
    raise exception 'invalid_payment_method'
      using errcode = 'P0001',
            detail = json_build_object('method', coalesce(p_payment_method, '<null>'))::text;
  end if;

  -- The trigger below would refuse this too, and it remains the enforcer --
  -- this is an early, cheaper refusal with the IDENTICAL error contract
  -- (same code, same detail shape), not a second copy of the moves table. It
  -- earns its place on one case the trigger cannot catch: an order already
  -- 'completed' would reach the trigger as completed -> completed, which the
  -- same-status early return waves through -- so without this guard a second
  -- call would post a whole second sale and only fail on the sale-link
  -- immutability check afterwards, if at all.
  if v_order.status <> 'ready' then
    raise exception 'invalid_order_transition'
      using errcode = 'P0001',
            detail = json_build_object('from', v_order.status, 'to', 'completed')::text;
  end if;

  -- THE SNAPSHOT, not a fresh lookup. order_items froze product_name,
  -- unit_price_cents and quantity at checkout (20260926000050_orders.sql's
  -- header) because that is what the customer agreed to.
  --
  -- A line whose product has since been DELETED (order_items.product_id is
  -- `on delete set null`) is caught here by name rather than handed to
  -- complete_sale, which would raise `product  not found in this shop` with
  -- an empty uuid in the middle of it. Same treatment Task 3's
  -- findShortfalls gives such a line: fully unfillable, never silently
  -- dropped.
  select string_agg(oi.product_name, ', ' order by oi.product_name)
    into v_missing
    from public.order_items oi
   where oi.order_id = p_order_id and oi.product_id is null;
  if v_missing is not null then
    raise exception 'order_product_deleted'
      using errcode = 'P0001',
            detail = json_build_object('products', v_missing)::text;
  end if;

  -- `agreed_unit_price_cents` is the field complete_sale actually reads, and
  -- `unit_price_cents` is NOT it. Carts have carried the latter since 0001 and
  -- complete_sale has always ignored it -- verify-complete-sale-baseline sends
  -- 9999 in it on every cart while asserting the product's own price, so that
  -- is pinned behaviour rather than an accident. It is left here, still
  -- ignored, because this payload is also what the client's own shortfall
  -- table is built from (storefront-admin.ts:481) and because repurposing it
  -- would change what EVERY caller of complete_sale charges.
  --
  -- The value in both is the same number: the price this order was quoted at,
  -- frozen at checkout by place_storefront_order from the shop's own
  -- products.price_cents (20260927000000:409). THE ORDER'S OWN NUMBERS ARE NOW
  -- AUTHORITATIVE -- a shop that re-priced afterwards no longer strands the
  -- order, and the customer is charged what they agreed to.
  select coalesce(jsonb_agg(jsonb_build_object(
           'product_id',              oi.product_id,
           'quantity',                oi.quantity,
           'unit_price_cents',        oi.unit_price_cents,
           'agreed_unit_price_cents', oi.unit_price_cents)
         order by oi.product_name), '[]'::jsonb)
    into v_items
    from public.order_items oi
   where oi.order_id = p_order_id;

  if jsonb_array_length(v_items) = 0 then
    raise exception 'order_has_no_items' using errcode = 'P0001';
  end if;

  -- ── This transaction is fulfilling this order, provably ──────────────
  --
  -- Written BEFORE complete_sale runs, because complete_sale is what reads it:
  -- a line filed BELOW today's shelf price needs `discounts.manual`
  -- (20260929000050), and a shop that raised a price after a customer ordered
  -- turns every fulfilment of that order into exactly such a line. Requiring a
  -- discounting permission to hand over a web order is the wrong question --
  -- the price being honoured is one the SHOP published, not one a cashier
  -- invented -- so complete_sale exempts a line it can see is part of a
  -- fulfilment in flight. This row is how it sees that.
  --
  -- Provenance, not a claim: storefront_order_fulfilments grants nothing to
  -- `authenticated`, has row level security on and no policy, and is written
  -- here only because this function is SECURITY DEFINER and runs as its owner.
  -- The xact_id stamped on it is what stops a row left behind by an earlier
  -- call authorising anything later. The full argument is in this migration's
  -- header; the same posture, one level over, is
  -- 20260928000500_order_completion_provenance.sql.
  --
  -- `on conflict` for the same reason the completion row below has one: the
  -- status guard above already refuses a second call once the order is
  -- 'completed', so this is defensive rather than load-bearing. It re-stamps
  -- rather than doing nothing, because a mark carrying some older
  -- transaction's id would be worse than no mark at all -- it would look
  -- present and validate nothing.
  --
  -- It is rolled back with everything else if the completion fails: a refused
  -- order leaves no mark behind, which is what check 50's untouched fixtures
  -- also demonstrate.
  insert into public.storefront_order_fulfilments (order_id)
    values (p_order_id)
  on conflict (order_id) do update set xact_id = excluded.xact_id;

  -- The goods, and only the goods. The delivery fee is deliberately NOT in
  -- this payment: complete_sale would refuse it as an over-payment against a
  -- total it computed from the items alone (20260908000300:481), and rightly
  -- so. The fee's own money movement is posted below.
  --
  -- p_prices_include_tax => true, UNCONDITIONALLY. A storefront quotes a total
  -- and the customer accepts THAT total; there is no second, larger figure to
  -- collect at the door. Without it, a tax-charging shop could not complete an
  -- order at all: complete_sale added the shop's tax on top of the quote and
  -- then refused the quoted payment against its own larger total, so every
  -- order at such a shop failed with what read as an arithmetic complaint.
  -- Unconditional rather than `case when the shop charges tax`, because at a
  -- shop with tax off (or with no rate set) the flag produces the identical
  -- sale either way -- complete_sale's extraction branch requires both -- and a
  -- condition here would be a second, driftable copy of that rule.
  begin
    v_sale_id := public.complete_sale(
      p_shop_id             => v_order.shop_id,
      p_items               => v_items,
      p_payments            => jsonb_build_array(jsonb_build_object(
                                 'method',       p_payment_method,
                                 'amount_cents', v_order.subtotal_cents)),
      p_customer_name       => v_order.customer_name,
      p_customer_phone      => v_order.customer_phone,
      p_register_session_id => null,
      p_prices_include_tax  => true);
  exception
    when others then
      -- Bare `when others` with an explicit message match and an unconditional
      -- `raise;` otherwise -- the house pattern. complete_sale raises with
      -- plain RAISE EXCEPTION, so every one of these arrives as P0001 and the
      -- sqlstate alone cannot tell them apart; the text is the only handle
      -- there is. Anything unrecognised goes back up untouched.
      v_msg := sqlerrm;
      if v_msg like 'insufficient stock for %' then
        -- The shop can act on this: put the stock right, or ring the customer.
        -- The original message is carried along so the client can name the
        -- product and the numbers without this function re-deriving them.
        raise exception 'insufficient_stock'
          using errcode = 'P0001',
                detail = json_build_object('message', v_msg)::text;
      elsif v_msg like 'payments total % does not match sale total %'
         or v_msg like 'payments total % is more than sale total %' then
        -- ── THE GUARD STAYS; ITS MEANING NARROWS ──────────────────────────
        --
        -- It used to catch two things, and this migration has removed both:
        -- a shop that RE-PRICED a product between checkout and hand-over (the
        -- line is now filed at the agreed price, so the arithmetic no longer
        -- moves), and a shop that CHARGES TAX the storefront never showed (the
        -- tax now comes out of the quote instead of being added to it). Either
        -- would previously reach this branch; neither can now, and checks 46
        -- and 47 are the two proofs of that.
        --
        -- WHAT IS LEFT is the one disagreement that is still possible: the
        -- ORDER ROW versus THE ORDER'S OWN LINES. This function tenders
        -- orders.subtotal_cents, and complete_sale totals the items from the
        -- very same rows -- so these two can only differ if the order's stored
        -- subtotal is not the sum of its own items. place_storefront_order
        -- cannot produce such a row (it computes the subtotal FROM the lines,
        -- 20260927000000:420) and `authenticated` cannot edit either table
        -- (20260928000300), so reaching this now means a direct database edit,
        -- a restore, or a future writer that changed one and not the other.
        --
        -- That is exactly when refusing is right. Completing would post a sale
        -- for a figure the order does not agree with, and the shop's two
        -- records of one transaction would disagree forever. It is also a live
        -- regression net: a later copy-forward that dropped the agreed price
        -- would turn this branch back on for every re-priced order, loudly,
        -- rather than quietly charging today's shelf price.
        --
        -- The order's own lines are added to the detail so the disagreement is
        -- legible without a second query -- `quoted_cents` is what the order
        -- says it is worth, `lines_cents` what its items come to.
        select coalesce(sum(oi.unit_price_cents::bigint * oi.quantity), 0)
          into v_lines_cents
          from public.order_items oi
         where oi.order_id = p_order_id;
        raise exception 'order_total_changed'
          using errcode = 'P0001',
                detail = json_build_object(
                  'quoted_cents', v_order.subtotal_cents,
                  'lines_cents',  v_lines_cents,
                  'message',      v_msg)::text;
      elsif v_msg like 'agreed price for % is out of range%' then
        -- ── THE REFUSAL 20260929000200 CREATED AND DID NOT TRANSLATE ──────
        --
        -- Every line now goes to complete_sale as `agreed_unit_price_cents`,
        -- which puts it behind that field's per-line ceiling of 1,000,000,000
        -- cents (20260929000050). order_items.line_total_cents is a plain
        -- `integer`, so an order line ABOVE that ceiling and below int32 is
        -- storable and was completable before this branch -- it was priced
        -- from products.price_cents and met only the int32 bound. Now it is
        -- refused, and without this branch it is refused in complete_sale's
        -- own English, straight onto the shop's screen through
        -- orderErrorMessage's `default: return null`.
        --
        -- The original message is carried in the detail, exactly as
        -- `insufficient_stock` above carries its own: it names the product,
        -- the quantity and the ceiling, and re-deriving those here would be a
        -- second copy of a bound that lives in complete_sale.
        --
        -- ITS TWO SIBLING BOUNDS ARE DELIBERATELY NOT MAPPED, because neither
        -- can arrive here. `this line is out of range` measures a line priced
        -- from the SHELF against int32, and no line reaching complete_sale
        -- from this function is priced from the shelf -- the agreed price's
        -- ceiling is both lower and tested first. `this sale is out of range`
        -- measures the running total against int32, and orders.subtotal_cents
        -- is itself an `integer`, so an order whose lines sum past int32
        -- cannot be stored -- and if one somehow were, its subtotal could not
        -- equal that sum, which is the order_total_changed branch above. A
        -- `like` pattern wide enough to catch all three would also catch
        -- messages this function has never seen, and `else raise;` is the
        -- right answer to those.
        raise exception 'order_line_out_of_range'
          using errcode = 'P0001',
                detail = json_build_object('message', v_msg)::text;
      else
        raise;
      end if;
  end;

  -- ...AND THE MARK IS TAKEN STRAIGHT BACK DOWN. The undercut exemption exists
  -- for the duration of one call to complete_sale and must not outlive it by a
  -- single statement.
  --
  -- FOUND BY THE TEST, NOT REASONED ABOUT AFTERWARDS. Without this line,
  -- verify-order-transitions check 51b -- the same cashier, the same product,
  -- the same price, through complete_sale DIRECTLY, which must still be
  -- refused -- SUCCEEDED, because the mark written above was still valid for
  -- the rest of that transaction. Through PostgREST that window is
  -- unreachable: one RPC call is one transaction and a client cannot
  -- interleave a second statement into it. But "unreachable through the only
  -- door we ship today" is not the same claim as "cannot happen", and the
  -- second is cheap: one DELETE.
  --
  -- The xact_id check in complete_sale is NOT made redundant by this and stays
  -- where it is -- it is what makes a row that somehow survived (a future edit
  -- that drops this delete, a mark manufactured by a database superuser)
  -- authorise nothing anyway. Check 52b is that second layer, tested directly.
  --
  -- A consequence worth stating: this table is EMPTY outside a fulfilment in
  -- flight. It is a lock, not a log -- storefront_order_completions is the
  -- record of what happened, and it is written just below.
  delete from public.storefront_order_fulfilments where order_id = p_order_id;

  -- ── The completion is now provenanced, not merely stated ─────────────
  --
  -- Written as the table owner (this function is SECURITY DEFINER) before
  -- the order itself is touched, so the trigger fired by the UPDATE below
  -- finds it already there. `on conflict` rather than a bare insert only
  -- because this function's own status guard above already refuses a second
  -- call once the order is 'completed' -- this is defensive, not load-
  -- bearing: nothing in the ordinary path ever inserts the same order_id
  -- twice.
  insert into public.storefront_order_completions (order_id, sale_id)
    values (p_order_id, v_sale_id)
  on conflict (order_id) do update
    set sale_id = excluded.sale_id, xact_id = excluded.xact_id;

  -- ── The delivery fee, route B ─────────────────────────────────────────
  if v_order.delivery_fee_cents > 0 then
    select s.location_id into v_location from public.sales s where s.id = v_sale_id;

    -- The date the SALE was recognised on, read off the entry complete_sale
    -- just posted rather than recomputed. That inherits, for free and without
    -- a second copy, both the shop-local-date rule (Africa/Mogadishu, never a
    -- bare ::date -- 20260908000300:665) and the closed-period redirect that
    -- can push a sale's entry into the current month. Two entries for one
    -- order sitting in two different months would be a reconciliation problem
    -- with no fix once a period closes.
    --
    -- Null only when the sale posted no entry at all, which complete_sale
    -- deliberately allows for a sale that moved no money (a basket of free
    -- samples). A shop can still charge to deliver such a basket, so the fee
    -- entry falls back to the same shop-local date the sale would have used.
    select je.entry_date into v_entry_date
      from public.journal_entries je
      join public.sales s on s.journal_entry_id = je.id
     where s.id = v_sale_id;
    v_entry_date := coalesce(v_entry_date, public.shop_local_date());

    -- Two lines, equal and opposite. It balances by construction: there is no
    -- arithmetic here to get wrong, which is the main thing route B buys.
    --
    -- 4300 Delivery Income, NEVER 4000 Sales Revenue. Delivery carries no cost
    -- of sales, so putting it in 4000 mixes income with no matching COGS into
    -- goods revenue and flatters gross margin on every report -- the whole
    -- reason 20260928000000 created the account.
    --
    -- The id is KEPT, not discarded -- into v_fee_entry_id, which the closing
    -- UPDATE below stamps onto orders.delivery_entry_id
    -- (20260928000400_delivery_fee_reversal_link.sql) so the entry is
    -- reachable by more than the description string naming this order and
    -- this sale.
    select public.post_journal_entry(
      v_order.shop_id,
      v_entry_date,
      'Delivery on order #' || v_order.number || ' (sale ' || v_sale_id::text || ')',
      jsonb_build_array(
        jsonb_build_object(
          'code',         public.account_code_for_payment_method(p_payment_method),
          'amount_cents', v_order.delivery_fee_cents,
          'memo',         'Delivery paid by ' || p_payment_method),
        jsonb_build_object(
          'code',         '4300',
          'amount_cents', -v_order.delivery_fee_cents,
          'memo',         'Delivery on order #' || v_order.number)),
      v_location,
      'sale')
      into v_fee_entry_id;
  end if;

  -- Last, and in the same transaction as everything above: a completion that
  -- posts a sale but leaves the order 'ready' is worse than one that fails
  -- cleanly, because the shop's only signal that anything happened is the
  -- order list. The status, the sale link and the fee entry's link all move
  -- together, in one statement, which is also the only shape the trigger
  -- accepts.
  update public.orders
     set status = 'completed', sale_id = v_sale_id, delivery_entry_id = v_fee_entry_id
   where id = p_order_id;

  return v_sale_id;
end;
$$;

-- ── The grant ─────────────────────────────────────────────────────────────
--
-- Postgres grants EXECUTE to PUBLIC on every new function, so `grant execute`
-- on its own says nothing about who may call this -- and on a SECURITY DEFINER
-- function running as the owner, PUBLIC includes anon. The order is the one
-- 20260924000100_storefront_public_read.sql:103-109 establishes. Check 36 in
-- verify-order-transitions.sql is the assertion.
revoke execute on function public.complete_storefront_order(uuid, text) from public;
grant execute on function public.complete_storefront_order(uuid, text) to authenticated;
