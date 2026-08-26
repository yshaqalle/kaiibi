-- FULFILMENT USES THE PRICE THE CUSTOMER AGREED TO.
--
-- 20260929000000 through 20260929000150 gave public.complete_sale two optional
-- inputs and left them unused: a per-line `agreed_unit_price_cents`, and
-- `p_prices_include_tax`. This migration makes complete_storefront_order send
-- both, which is the entire point of the branch. Until now:
--
--   * a shop that RE-PRICED a product after a customer ordered could not
--     complete that order at all -- complete_sale re-priced every line from
--     today's products.price_cents, tendered payment came from the order's
--     snapshot, and the two did not meet. Every open order was stranded by a
--     price change;
--   * a shop that CHARGES TAX could not complete ANY order, ever. The
--     storefront quotes tax-exclusive; complete_sale added the tax on top and
--     then refused the quoted payment against its own larger total.
--
-- Both came back as `order_total_changed`, which is a sentence about prices
-- moving, given to a shop whose prices had not moved.
--
-- Now: each line carries `agreed_unit_price_cents` -- the price frozen on
-- order_items at checkout -- and the sale is filed tax-inclusive, so the tax
-- comes OUT of the quoted total instead of being added to it. The customer
-- pays what they were told, the shop's ledger balances, and the tax lands on
-- 2100 exactly where the till puts it.
--
-- ── THE PERMISSION QUESTION, AND HOW IT IS RESOLVED ───────────────────────
--
-- 20260929000050 gates an UNDERCUT -- a line filed below the current shelf
-- price -- on `discounts.manual`, and that gate is right: at a till, a cashier
-- who may not take one cent off through `discount_cents` must not be able to
-- file the whole line at one cent through `agreed_unit_price_cents`.
--
-- But a shop that RAISES a price after a customer ordered makes every
-- fulfilment of that order an undercut. Left alone, honouring a published
-- quote would require a discounting permission. All three roles
-- default_shop_roles() seeds carry `discounts.manual` (20260826000100:865
-- backfilled it onto every role holding `pos.access`), so most shops would
-- never see it -- but the most natural custom role a shop can build,
-- "cashier, may ring up sales, may not discount", would ring up till sales all
-- day and then be refused an ordinary web order, with a message about shelf
-- prices that names neither orders nor discounting.
--
-- THAT IS THE SAME CATEGORY ERROR 20260929000150 REMOVED FROM THE TAX FLAG,
-- and its header says where the answer belongs: "put any such rule in
-- complete_storefront_order, which knows the sale is a quote the shop itself
-- published. A gate here is a gate in the one place that has no context to
-- gate with."
--
-- So the fulfilment is exempted from the undercut gate, and the exemption
-- rests on a fact rather than on a permission:
--
--   AN ORDER'S FROZEN PRICE IS NOT A CALLER'S NUMBER. place_storefront_order
--   reads products.price_cents server-side and writes it onto order_items
--   (20260927000000:409-426); the customer never sends a price and neither
--   does the shop member completing the order. Filing that line is the shop
--   keeping its own published word. `discounts.manual` means "may type your
--   own discount amount", and nobody typed anything.
--
-- WHAT IS NOT WEAKENED: an ordinary till caller is untouched. The exemption
-- requires a fulfilment to be IN FLIGHT IN THIS TRANSACTION and requires the
-- order to have quoted THIS product at THIS price. verify-order-transitions
-- check 51 is both halves on one member -- the same cashier, without
-- `discounts.manual`, completes the order and is still refused the identical
-- undercut through complete_sale directly.
--
-- ── THE TRUST IS VERIFIABLE, NOT ASSERTED ─────────────────────────────────
--
-- complete_sale is handed a JSON payload and cannot be told anything by the
-- caller that the caller could not also lie about. So it is told nothing. A
-- new table records that a fulfilment is under way:
--
--   public.storefront_order_fulfilments (order_id, xact_id)
--
-- with NO grant to `anon` or `authenticated`, row level security enabled and
-- NOT ONE policy -- so Postgres denies every row to every role but the owner,
-- for every command, whatever privileges exist elsewhere. Only a SECURITY
-- DEFINER function running as the owner can write one, and only
-- complete_storefront_order does. complete_sale's undercut gate then asks for
-- a row stamped `pg_current_xact_id()`.
--
-- IT IS DELIBERATELY NOT A set_config MARKER. This repo already rejected one
-- for the neighbouring problem, on inspection rather than on style:
-- 20260928000500's header shows that custom GUCs carry no privilege system --
-- `authenticated` can call set_config for any key it reads out of a migration
-- file -- so a marker authenticates only that a value was set, which the
-- attacker can always arrange. A row in a table nobody can write is a
-- different kind of claim.
--
-- IT IS A LOCK, NOT A LOG. complete_storefront_order deletes the row as soon
-- as complete_sale returns, so the exemption lasts exactly as long as the call
-- it exists for and the table is empty at every other moment. That is not
-- decoration: without the delete, check 51b -- the same cashier undercutting
-- the same product through complete_sale directly, which must be refused --
-- passed, because the mark was still valid later in the same transaction. It
-- was the test that said so.
--
-- AND IT CANNOT LEAK ACROSS TRANSACTIONS, for the same reason the completion
-- trigger cannot: transaction ids are monotonic and never reused, so a mark
-- from an earlier, already-finished call never equals this one's. A client
-- cannot interleave its own statements inside a single RPC call, so the only
-- way the predicate holds is that complete_storefront_order is, right now,
-- part-way through fulfilling that order. Check 52 proves both halves --
-- `authenticated` cannot write a mark, and a mark stamped by another
-- transaction authorises nothing.
--
-- WHY A SECOND TABLE, beside storefront_order_completions. They say different
-- things at different times. `completions` records that an order BECAME a sale
-- and is read by the orders trigger AFTER complete_sale returns -- it cannot
-- be written any earlier, because until then there is no sale id, and its
-- sale_id is `not null` for exactly that reason. `fulfilments` records that a
-- transaction is fulfilling an order and must exist BEFORE complete_sale runs.
-- Making one table serve both would mean relaxing that `not null` on the table
-- the completion trigger trusts, to buy nothing.
--
-- ── WHAT order_total_changed STILL CATCHES ────────────────────────────────
--
-- It stays, and it stops firing for either of the two things it used to fire
-- for. What is left is the order ROW disagreeing with the order's own LINES:
-- this function tenders orders.subtotal_cents while complete_sale totals the
-- items from the same rows, so they can now only differ if the stored subtotal
-- is not the sum of its own items -- a direct database edit, a restore, or a
-- future writer that changes one and not the other. Refusing is right: the
-- alternative posts a sale the order itself disagrees with. It is also a
-- regression net -- a later copy-forward that dropped the agreed price turns
-- this branch back on for every re-priced order, loudly. Re-founded at check
-- 50, in both directions, with a control that completes once the two agree.
--
-- ── THE PER-LINE ESCAPE ROUTE ─────────────────────────────────────────────
--
-- A total-only check cannot see two lines moving in OPPOSITE directions by
-- equal amounts: quote 1000 + 2000, re-price to 1500 + 1500, and the sale
-- posts at two prices the customer never agreed to while every total ties.
-- Honouring the agreed price closes it by construction rather than by
-- checking, and check 49 is that fixture (+500 / -500) asserting the sale's
-- lines against the order's snapshot line for line.
--
-- ── THE DELIVERY FEE IS UNCHANGED, AND DELIBERATELY SO ────────────────────
--
-- Route B still posts the fee as its own two-line entry to 4300 Delivery
-- Income, at the full fee, with no tax carved out of it. NO delivery-fee
-- parameter is added to complete_sale here: one would require deleting
-- delete_sale's fourth UNION branch (20260928000400) in the same migration, or
-- the fee reverses twice on a deleted sale. Checks 25-28 (unchanged) and 48
-- are the two ends of that.
--
-- ── COPIED FORWARD ────────────────────────────────────────────────────────
--
-- Both functions are reproduced IN FULL, per this repo's convention
-- (20260908000150's header). complete_sale comes from
-- 20260929000150_complete_sale_quoted_tax_ungated.sql, its newest definition,
-- with ONE change inside the function: a third conjunct on the undercut gate.
-- complete_storefront_order comes from
-- 20260928000600_complete_storefront_order_pos_access.sql, its newest
-- definition, with four: the fulfilment mark, the agreed price in the payload,
-- the tax-inclusive flag, and the narrowed order_total_changed branch. Both
-- diffs were produced by textual substitution against those files rather than
-- retyped, and supabase/tests/accumulated-rpc-edits.test.ts guards every edit
-- either has ever carried.
--
-- NEITHER SIGNATURE CHANGES, so both are plain `create or replace` with no
-- drop, and the ACLs survive. The revoke/grant pairs at the foot restate
-- rather than repair -- written anyway, in the revoke-then-grant order, because
-- `grant execute` alone is a no-op against Postgres's default EXECUTE-to-PUBLIC
-- and a reader must not have to know which migrations dropped and which
-- replaced to know who can call these.

-- ── storefront_order_fulfilments: a fulfilment in flight, provably ────────
create table public.storefront_order_fulfilments (
  order_id uuid primary key references public.orders(id) on delete cascade,
  -- The transaction that is fulfilling it, stamped at INSERT. complete_sale
  -- requires this to equal pg_current_xact_id(), which is constant for a
  -- transaction's whole duration and never reused afterwards.
  xact_id  xid8 not null default pg_current_xact_id()
);

alter table public.storefront_order_fulfilments enable row level security;
-- No policy, on purpose: with row level security enabled and zero policies,
-- Postgres denies every row to every role but the table owner, for every
-- command, independent of any grant. The same posture 20260928000500 gives
-- storefront_order_completions, and for the same reason -- two independent
-- layers, so neither one re-opening by accident is enough on its own.

-- Belt to that layer's braces, and the same statement 20260928000500 wrote for
-- the same reason: on a hosted project where 20260818000600's fallback never
-- took, a brand new table could still inherit `grant all` from the original
-- Supabase bootstrap default. This makes the outcome the same everywhere
-- rather than only on a local stack that happens to be clean.
revoke all on public.storefront_order_fulfilments from anon, authenticated;

-- ── complete_sale, re-created in full ─────────────────────────────────────

create or replace function public.complete_sale(
  p_shop_id uuid,
  p_items jsonb,
  p_payments jsonb,
  p_customer_name text default null,
  p_customer_phone text default null,
  p_customer_email text default null,
  p_cashier_name text default null,
  p_discount_cents integer default 0,
  p_customer_id uuid default null,
  p_created_at timestamptz default null,
  p_location_id uuid default null,
  p_points_redeemed integer default 0,
  p_register_session_id uuid default null,
  p_allow_balance boolean default false,
  -- THE PRICES IN THIS CART ALREADY HAVE THE TAX IN THEM. Default false, so
  -- every caller that existed before this migration goes on being taxed on top
  -- exactly as it was. See the header for what it does and what it does not.
  p_prices_include_tax boolean default false
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  -- The most a line an AGREED PRICE was sent for may come to, and nothing else.
  -- 1,000,000,000 cents is ten million dollars, the same figure
  -- place_storefront_order (20260927000000:230) puts on a whole order, and it is
  -- a CEILING rather than a business rule: an agreed price arrives in a JSON
  -- payload from a caller, and a caller must not be able to decide how large a
  -- number this function multiplies. Held in bigint and compared against a
  -- bigint product, so the test happens BEFORE the 32-bit multiplication that
  -- would otherwise raise `integer out of range` from mid-function.
  --
  -- IT DOES NOT APPLY TO AN ORDINARY TILL SALE, and the first wave of this fix
  -- applying it to one is the defect fix wave 2 exists to correct. See the
  -- header: a shop's own shelf price is not a caller's number, and a plain sale
  -- anywhere in the 1,000,000,000 to 2,147,483,647 window worked before this
  -- branch and must go on working.
  c_max_line_cents constant bigint := 1000000000;
  -- Where the ARITHMETIC stops, which is a different kind of thing entirely and
  -- is why it is a different constant. v_line and v_gross_cents are both
  -- `integer`, so 2,147,483,647 is the last figure either can hold: past it the
  -- old function did not refuse the sale, it raised a bare
  -- `integer out of range` from the middle of the register's write path with
  -- nothing in it to say which line or why.
  --
  -- Every line total and the running sale total are measured against it, agreed
  -- price or not -- an accumulation overflows the same way whether the price
  -- came from the cart or from the shelf. Because it sits exactly at the point
  -- of failure, no call that ever succeeded can reach it: this converts a crash
  -- into an explanation and refuses nothing that used to work.
  c_max_int_cents constant bigint := 2147483647;
  v_sale_id uuid;
  v_location_id uuid;
  v_item jsonb;
  v_payment jsonb;
  v_product public.products%rowtype;
  v_available integer;
  v_qty integer;
  v_line integer;
  -- The same line total, computed WIDE. `v_unit_price * v_qty` is 32-bit
  -- multiplication and a product priced 1,500,000,000 sold three at a time
  -- overflows it -- with no agreed price anywhere in the cart, so the bound
  -- inside the agreed-price block never sees it. Computed here in bigint,
  -- bounded, and only then narrowed into v_line, which is the order that lets
  -- the caller hear a sentence instead of `integer out of range`.
  v_line_cents bigint;
  v_line_discount integer;
  -- The price this line is actually filed at: the agreed price when the cart
  -- carried one, products.price_cents otherwise.
  v_unit_price integer;
  -- The agreed price exactly as it arrived, or NULL when the cart sent none.
  -- Kept separate from v_unit_price so that ABSENT and ZERO stay different
  -- answers: a shop that promised to throw an item in agreed a price of 0, and
  -- collapsing the two would charge the customer list for it.
  --
  -- BIGINT, not integer, and that is the whole of finding 2(a). As an integer,
  -- an agreed price of 3,000,000,000 raised `value "3000000000" is out of range
  -- for type integer` AT THE PARSE -- one statement before the bound that exists
  -- to turn exactly that into a sentence. Held wide enough to survive being
  -- read, so the bound gets to speak, and narrowed into v_unit_price only after
  -- it has passed.
  v_agreed_price bigint;
  v_gross_cents integer := 0;
  v_total_cents integer := 0;
  v_item_count integer := 0;
  v_payments_total integer := 0;
  v_primary_method text;
  v_discount_cents integer := greatest(coalesce(p_discount_cents, 0), 0);
  v_tax_enabled boolean;
  v_tax_rate numeric;
  v_tax_cents integer := 0;
  -- The tax that came OUT of a quoted total, and ZERO on every other call.
  --
  -- Not the same variable as v_tax_cents and not derivable from it: v_tax_cents
  -- is what the shop owes the state either way, and the posting side needs to
  -- know which DIRECTION it arrived from. Revenue is credited at list less this
  -- figure -- on an ordinary till sale that is a subtraction of nothing, and on
  -- a quoted sale it is what stops the entry crediting the state's money as the
  -- shop's earnings and failing to balance by exactly that amount.
  v_included_tax_cents integer := 0;
  -- coalesce, because the flag arrives from a caller and a caller can send an
  -- explicit NULL. Read raw, `if not p_prices_include_tax` would be NULL rather
  -- than TRUE for such a call, the add-on branch below would be skipped, and
  -- the sale would quietly go out untaxed -- the one failure mode of this whole
  -- change that costs the shop money without saying anything.
  v_prices_include_tax boolean := coalesce(p_prices_include_tax, false);
  v_loyalty_enabled boolean;
  v_points_per_usd numeric;
  v_cents_per_point integer;
  v_grace_days integer;
  v_pending_points integer := 0;
  v_points_available integer := 0;
  v_loyalty_active boolean := false;
  v_points_redeemed integer := greatest(coalesce(p_points_redeemed, 0), 0);
  v_redeem_cents integer := 0;
  v_balance integer;
  v_points_earned integer := 0;
  v_session public.register_sessions%rowtype;
  v_promo_id uuid;
  v_promo_name text;
  v_promo_type text;
  v_promo_value integer;
  v_promo_starts_at timestamptz;
  v_promo_ends_at timestamptz;
  v_expected_discount integer;
  v_cogs_cents integer := 0;
  -- What is still owed at the end of the sale. NOT v_balance -- that one holds
  -- the customer's loyalty POINTS balance and is only ever assigned inside the
  -- redemption branch above, so reading it as money would post a receivable in
  -- points on a redeeming sale and none at all on a plain credit sale.
  v_owed_cents integer := 0;
  -- The line-level and promotion discounts, summed off the rows this sale just
  -- wrote. NOT derivable from v_gross_cents, which is already net of them --
  -- see the posting block for what that cost.
  v_item_discount_cents integer := 0;
  v_entry_id uuid;
  v_lines jsonb;
  -- The date this sale HAPPENED, in the shop's own time. Not the same thing as
  -- the date it is RECOGNISED on, which is v_posted_date below.
  v_entry_date date;
  -- The status of the period v_entry_date falls in, or NULL when no row exists
  -- for that month yet. NULL is not "closed" and is not "open" either -- it is
  -- "nobody has traded in this month", which open_period_for turns into an open
  -- period on demand. The difference matters: see where it is read.
  v_period_status text;
  -- The date the entry is actually posted on. Equal to v_entry_date except when
  -- that month has already been closed or locked.
  v_posted_date date;
begin
  if not public.has_shop_permission(p_shop_id, 'pos.access') then
    raise exception 'not authorized for shop %', p_shop_id;
  end if;
  -- A transaction-level discount with no promotion behind it is a cashier
  -- typing an arbitrary number, the same as a line discount, and needs the
  -- same permission. Checked here, before anything is written, rather than
  -- at the end of the function: v_discount_cents is already known from the
  -- DECLARE section, so there is no reason to do the sale, the stock, the
  -- payments and the loyalty ledger first only to roll it all back.
  if v_discount_cents > 0
     and not public.has_shop_permission(p_shop_id, 'discounts.manual') then
    raise exception 'not authorized to enter a manual discount';
  end if;
  -- A sale with nothing paid on it is legitimate only as credit, against a
  -- named customer. Everything else still has to bring money to the counter.
  if p_payments is null or jsonb_array_length(p_payments) = 0 then
    if not coalesce(p_allow_balance, false) then
      raise exception 'at least one payment is required';
    end if;
    if p_customer_id is null then
      raise exception 'a sale can only be left unpaid against a customer';
    end if;
  end if;

  if p_location_id is null then
    select l.id into v_location_id from public.shop_locations l
      where l.shop_id = p_shop_id
      order by l.is_primary desc, l.created_at asc
      limit 1;
    if v_location_id is null then
      raise exception 'shop % has no location to record this sale against', p_shop_id;
    end if;
  else
    select l.id into v_location_id from public.shop_locations l
      where l.id = p_location_id and l.shop_id = p_shop_id;
    if v_location_id is null then
      raise exception 'location % does not belong to shop %', p_location_id, p_shop_id;
    end if;
    if not public.can_access_location(v_location_id) then
      raise exception 'not authorized for location %', p_location_id;
    end if;
  end if;

  -- The session, when the client sent one. Validated rather than trusted: a
  -- sale filed against a closed session would land in a drawer count somebody
  -- has already signed off, and one filed against another branch's session
  -- would put the money in the wrong till.
  if p_register_session_id is not null then
    select * into v_session from public.register_sessions where id = p_register_session_id;
    if v_session.id is null then
      raise exception 'register session % not found', p_register_session_id;
    end if;
    if v_session.shop_id <> p_shop_id then
      raise exception 'register session % does not belong to shop %', p_register_session_id, p_shop_id;
    end if;
    if v_session.location_id <> v_location_id then
      raise exception 'register session % is at a different location than this sale', p_register_session_id;
    end if;
    if v_session.closed_at is not null then
      raise exception 'register session % is already closed', p_register_session_id;
    end if;
  end if;

  -- A branch that requires an open register means it: without this the setting
  -- is advisory, and the client is the party it is meant to constrain. Read off
  -- the resolved location, so turning it on at one branch never stops another
  -- selling.
  if p_register_session_id is null
     and (select require_open_register from public.shop_locations where id = v_location_id) then
    raise exception 'this store requires an open register before a sale can be rung up';
  end if;

  -- 'unpaid', not a real method. sales.payment_method summarises how the money
  -- came in, and on a sale where none has, every other value is a lie that
  -- reads as collected in the transactions ledger. settle_sale_balance replaces
  -- it with the real method once money actually arrives.
  v_primary_method := coalesce(p_payments->0->>'method', 'unpaid');
  if v_primary_method not in ('cash','zaad','edahab','other','unpaid') then
    raise exception 'invalid payment method %', v_primary_method;
  end if;

  select tax_enabled, tax_rate_percent,
         loyalty_enabled, loyalty_points_per_usd, loyalty_cents_per_point,
         loyalty_points_available_after_days
    into v_tax_enabled, v_tax_rate,
         v_loyalty_enabled, v_points_per_usd, v_cents_per_point,
         v_grace_days
    from public.shops where id = p_shop_id;

  -- NOTHING IS ASKED ABOUT p_prices_include_tax HERE, AND THAT IS DELIBERATE.
  --
  -- 20260929000100 put a `discounts.manual` check on this exact spot -- refusing
  -- a tax-inclusive sale at a tax-charging shop unless the caller could type a
  -- manual discount -- and this migration removed it. The flag is not a
  -- discount: it states how the price was QUOTED, and the payments-equality
  -- guard below means a caller who sets it must actually collect the lower
  -- figure, so nothing is skimmable. Task 4's storefront fulfilment sets this
  -- flag on EVERY order at a tax-charging shop, so a gate here makes ordinary
  -- online fulfilment need a discounting permission. See this migration's
  -- header for the full argument, and put any such rule in
  -- complete_storefront_order, which knows the sale is a quote the shop itself
  -- published. Baseline check 31 is the behavioural half.
  --
  -- The `discounts.manual` gate on an UNDERCUT through
  -- `agreed_unit_price_cents` is a different thing entirely and is untouched --
  -- see the block further down and 20260929000050's header.

  -- The module check is not belt and braces. public.customers and
  -- customer_points_ledger both carry enforce_shop_module('customers') as a
  -- BEFORE trigger, and security definer does not bypass a trigger -- so
  -- touching either on a lapsed shop would raise module_not_included and refuse
  -- the whole sale. A shop that stops paying must still be able to sell.
  v_loyalty_active := coalesce(v_loyalty_enabled, false)
    and p_customer_id is not null
    and public.shop_has_module(p_shop_id, 'customers');

  if v_points_redeemed > 0 and not v_loyalty_active then
    raise exception 'loyalty points cannot be redeemed on this sale';
  end if;

  insert into public.sales (shop_id, location_id, created_by, payment_method, customer_name, customer_phone, customer_email, cashier_name, discount_cents, customer_id, created_at, register_session_id)
    values (p_shop_id, v_location_id, auth.uid(), v_primary_method, nullif(p_customer_name, ''), nullif(p_customer_phone, ''), nullif(p_customer_email, ''), nullif(p_cashier_name, ''), v_discount_cents, p_customer_id, coalesce(p_created_at, now()), p_register_session_id)
    returning id into v_sale_id;

  -- Ordered by product id so two concurrent sales touching the same products
  -- take their row locks in the same order and cannot deadlock. Ordinality is
  -- the tiebreaker, because a cart can list the same product twice.
  --
  -- CARRIED FORWARD FROM 20260905000000_complete_sale_lock_order.sql, which is
  -- newer than the 20260831000100 definition this function is otherwise copied
  -- from. That migration applies its fix by TEXT SUBSTITUTION against the live
  -- pg_proc source rather than by re-creating the function, so it appears in no
  -- CREATE OR REPLACE block anywhere in this directory -- which is exactly how
  -- a grep for the newest definition, and accumulated-rpc-edits.test.ts along
  -- with it, both miss it. Re-creating this
  -- function from the 20260831000100 text WITHOUT this line silently reverts a
  -- live deadlock fix on the hottest path in the app. verify-sale-lock-order
  -- caught it; nothing else did.
  for v_item in
    select value from jsonb_array_elements(p_items) with ordinality as t(value, ord)
      order by (value->>'product_id'), ord
  loop
    v_qty := (v_item->>'quantity')::integer;
    if v_qty is null or v_qty <= 0 then
      raise exception 'invalid quantity in cart item';
    end if;

    select * into v_product from public.products
      where id = (v_item->>'product_id')::uuid and shop_id = p_shop_id;

    if v_product.id is null then
      raise exception 'product % not found in this shop', v_item->>'product_id';
    end if;

    select stock into v_available from public.product_location_stock
      where product_id = v_product.id and location_id = v_location_id
      for update;

    if coalesce(v_available, 0) < v_qty then
      raise exception 'insufficient stock for % at this location: has %, need %',
        v_product.name, coalesce(v_available, 0), v_qty;
    end if;

    v_line_discount := greatest(coalesce((v_item->>'discount_cents')::integer, 0), 0);
    v_promo_id := nullif(v_item->>'promotion_id', '')::uuid;

    -- ── THE AGREED PRICE ──────────────────────────────────────────────────
    --
    -- A NEW FIELD, and it had to be. Carts have carried `unit_price_cents`
    -- since 0001 and this function has never read it -- every line has always
    -- been priced from products.price_cents, which is the right answer at a
    -- till, where the correct price is the price right now. Making that field
    -- authoritative would silently change what every existing caller charges,
    -- so the agreed price is `agreed_unit_price_cents` and `unit_price_cents`
    -- goes on being ignored. verify-complete-sale-baseline sends 9999 in the
    -- old field on every cart it rings up, including the agreed-price ones,
    -- so the two cannot be confused for one another.
    --
    -- What it is FOR: a storefront order is a promise made earlier. order_items
    -- froze the quantity and the price at checkout because that is what the
    -- customer agreed to, and when the shop later completes the order the
    -- customer must be charged what they were quoted -- not what the shelf says
    -- today. Absent, this whole block is a no-op and the line prices exactly as
    -- it did before this migration.
    --
    -- PARSED AS BIGINT. See v_agreed_price's declaration: as an integer, a value
    -- past the 32-bit ceiling died on this very line with a Postgres cast error
    -- naming a type, one statement before the bound written to catch it.
    v_agreed_price := nullif(v_item->>'agreed_unit_price_cents', '')::bigint;

    if v_agreed_price is not null then
      -- AN AGREED PRICE AND A PROMOTION ARE TWO ANSWERS TO ONE QUESTION.
      -- A promotion's discount is recomputed server-side from
      -- products.price_cents further down and is a reduction OFF the list
      -- price; an agreed price REPLACES the list price. Together, either the
      -- offer comes off a price it was never written against, or the agreed
      -- price swallows it -- and whichever this function happened to do, the
      -- shop could no longer say which price the customer was actually
      -- promised. Refused rather than resolved, because there is no resolution
      -- that is not a guess about what somebody meant.
      --
      -- The message is stable text with the product name LAST, so a caller can
      -- match the prefix and turn it into a sentence in the shopkeeper's own
      -- words -- the same handle complete_storefront_order already takes on
      -- `insufficient stock for %` (20260928000200:352).
      if v_promo_id is not null then
        raise exception 'an agreed price cannot be combined with a promotion on the same line (%)', v_product.name;
      end if;

      -- IT IS INPUT, NOT TRUTH. It arrives in a JSON payload from a caller and
      -- goes straight onto sale_items.unit_price_cents and into the revenue
      -- credit, so it is bounded on both sides before it is used.
      --
      -- Zero is legal and deliberately so -- see v_agreed_price's declaration.
      -- Negative is not: a negative line PAYS the customer, drives the sale's
      -- total below the goods on it and credits 4000 the wrong way, and the
      -- `v_line < 0` guard below would not catch it (that one fires only when a
      -- discount is the cause).
      if v_agreed_price < 0 then
        raise exception 'agreed price for % cannot be negative (got %)', v_product.name, v_agreed_price;
      end if;

      -- Bounded on the LINE, not on the unit, and computed in bigint. A unit
      -- price under the 32-bit ceiling can still make a line that is over it --
      -- 3 units at 1,000,000,000 is 3,000,000,000 -- and unbounded that is a
      -- bare `integer out of range` raised from the multiplication below, with
      -- nothing in it to say which line or why.
      if v_agreed_price::bigint * v_qty > c_max_line_cents then
        raise exception 'agreed price for % is out of range: % x % is more than the % cents one line may carry',
          v_product.name, v_agreed_price, v_qty, c_max_line_cents;
      end if;

      -- ── AN UNDERCUT IS A DISCOUNT, WHATEVER FIELD IT ARRIVES IN ─────────
      --
      -- Twelve statements below this one, a line discount with no promotion
      -- behind it is refused without `discounts.manual`, and it has been since
      -- 0024. Without this check the same cashier who may not take ONE CENT off
      -- through `discount_cents` may file the whole line at ONE CENT through
      -- `agreed_unit_price_cents` -- the same money, the same till, the same
      -- person, and the gate gone. A new field is not a new justification.
      --
      -- ON THE UNDERCUT, NOT ON THE FIELD. `< v_product.price_cents` is the
      -- whole condition: an agreed price at or above the shelf price takes
      -- nothing out of the shop and asks for nothing extra. That is what keeps
      -- this a gate on the DIRECTION rather than on the feature -- a shop that
      -- CUT its price after quoting still fulfils the order untouched.
      --
      -- LAST IN THIS BLOCK, deliberately. A negative agreed price is also below
      -- the shelf price, and a cashier who sent -500 should be told it is
      -- negative rather than that they are not authorised to send it.
      --
      -- The message is stable text with the product name LAST, so a client can
      -- match the prefix and say it in the shopkeeper's own words -- the same
      -- handle the promotion clash above takes.
      --
      -- ── ...UNLESS THIS IS THE SHOP HONOURING ITS OWN PUBLISHED QUOTE ────
      --
      -- The third conjunct, and the whole of 20260929000200's change to this
      -- function. Read it as: an undercut needs `discounts.manual` UNLESS this
      -- transaction is fulfilling a storefront order that quoted THIS product
      -- at THIS price.
      --
      -- WHY IT IS NOT A DISCOUNT AT ALL. order_items.unit_price_cents is not a
      -- caller's number: place_storefront_order reads it off
      -- products.price_cents server-side and writes it (20260927000000:409,
      -- :426), so an order's frozen price is a price THE SHOP ITSELF
      -- PUBLISHED. Completing that order at that price is the shop keeping its
      -- own word, not a cashier inventing a figure at the counter --
      -- and `discounts.manual` means "may type your own discount amount".
      -- Without this, a shop that RAISED a price after a customer ordered
      -- would find fulfilment gated on a discounting permission, which is the
      -- same category error 20260929000150 removed from the tax flag and for
      -- the same reason: it makes the ORDINARY path need an exceptional
      -- permission, and refuses it with a message naming neither orders nor
      -- discounting.
      --
      -- WHY THE TRUST IS VERIFIABLE RATHER THAN ASSERTED. The mark lives in
      -- public.storefront_order_fulfilments, which grants nothing to `anon` or
      -- `authenticated` -- not even SELECT -- and carries row level security
      -- with no policy at all. Only a SECURITY DEFINER function running as the
      -- table's owner can write one, and only complete_storefront_order does.
      -- It is deliberately NOT a set_config marker: 20260928000500's header
      -- shows why one would not have held (custom GUCs have no privilege
      -- system, so any caller can set the value the check is looking for).
      --
      -- ...AND IT CANNOT LEAK ACROSS TRANSACTIONS. `f.xact_id =
      -- pg_current_xact_id()` is the same rule the completion trigger uses:
      -- transaction ids are monotonic and never reused, so a mark left behind
      -- by an earlier, already-finished call can never equal this
      -- transaction's id. A client cannot interleave statements inside one
      -- RPC call, so the only way this predicate is true is that
      -- complete_storefront_order, in this very transaction, is part-way
      -- through fulfilling that order.
      --
      -- ...AND IT IS PER LINE, NOT PER CALL. The order must actually carry an
      -- item for this product at exactly this price. A fulfilment in flight
      -- therefore excuses only the prices that order quoted, and never a line
      -- somebody added beside them.
      --
      -- ORDER MATTERS: the permission check stays FIRST, so the ordinary till
      -- path -- which is every caller that holds `discounts.manual` -- never
      -- runs this lookup at all.
      if v_agreed_price < v_product.price_cents
         and not public.has_shop_permission(p_shop_id, 'discounts.manual')
         and not exists (
           select 1
             from public.storefront_order_fulfilments f
             join public.orders o       on o.id = f.order_id
             join public.order_items oi on oi.order_id = f.order_id
            where f.xact_id = pg_current_xact_id()
              and o.shop_id = p_shop_id
              and oi.product_id = v_product.id
              and oi.unit_price_cents = v_agreed_price) then
        raise exception 'not authorized to file a line below the shelf price (%)', v_product.name;
      end if;
    end if;

    -- coalesce, never `case when v_agreed_price > 0`. The natural-looking
    -- version reads a promised-free item as "no agreed price" and charges list
    -- for the one thing the shop said it would give away.
    --
    -- ::integer narrows the bigint agreed price, and it is SAFE HERE and only
    -- here: everything above has already refused a negative one and refused one
    -- whose line would pass c_max_line_cents, so what reaches this cast is
    -- between 0 and 1,000,000,000 and fits. Narrowing any earlier is what
    -- 20260929000000 did, and it is what made the bound unreachable.
    v_unit_price := coalesce(v_agreed_price, v_product.price_cents)::integer;

    if v_promo_id is null then
      -- No promotion behind it means a cashier typed a number, which is the
      -- one discount path nothing has ever recorded or restricted. Anyone may
      -- APPLY an offer; entering your own amount is a separate permission.
      if v_line_discount > 0
         and not public.has_shop_permission(p_shop_id, 'discounts.manual') then
        raise exception 'not authorized to enter a manual discount';
      end if;
      v_promo_name := null;
    else
      -- A claimed promotion is verified against the row, not taken on trust:
      -- otherwise "attach any uuid" would be a way around the permission above,
      -- and the name written onto the sale forever would be the caller's text.
      -- `active and archived_at is null` so a paused or archived promotion's id
      -- cannot be attached to a new sale -- otherwise a cashier without
      -- discounts.manual could use a store-wide promotion's id, paused or not,
      -- to take a discount the permission exists to prevent.
      select name, discount_type, discount_value, starts_at, ends_at
        into v_promo_name, v_promo_type, v_promo_value, v_promo_starts_at, v_promo_ends_at
        from public.promotions
       where id = v_promo_id and shop_id = p_shop_id and active and archived_at is null;
      if not found then
        -- The lookup filters on shop, active and archived_at together, so a miss
        -- here means any of those -- naming only the shop sent readers hunting
        -- for a tenancy bug when the offer was simply paused.
        raise exception 'promotion % is not available to use (wrong shop, paused, or archived)', v_promo_id;
      end if;

      -- The window IS enforced here, with slack on both edges so a real cart
      -- is never refused at the boundary. One minute of slack on the start
      -- absorbs clock skew between a till and the server -- a device a
      -- minute fast must not be told an offer hasn't started yet. Ten
      -- minutes of slack on the end is a grace window: a cashier who opened
      -- the cart while the offer was live must be able to finish checking
      -- out a few minutes after it lapsed, rather than have the sale refused
      -- at the payment screen with a total the customer has already been
      -- told.
      if v_promo_starts_at is not null and v_promo_starts_at > now() + interval '1 minute' then
        raise exception 'promotion % has not started yet', v_promo_name;
      end if;
      if v_promo_ends_at is not null and v_promo_ends_at <= now() - interval '10 minutes' then
        raise exception 'promotion % has ended', v_promo_name;
      end if;

      v_expected_discount := case
        when v_promo_type = 'percentage'
          then round(v_product.price_cents::numeric * v_qty * v_promo_value / 100)::integer
        else least(v_promo_value, v_product.price_cents * v_qty)
      end;
      -- Greater-than rather than not-equal: a client rounding a percentage a
      -- cent differently must not fail a legitimate sale, but nobody may claim
      -- more than the offer actually gives.
      if v_line_discount > v_expected_discount then
        raise exception 'discount % exceeds what promotion % allows (%)',
          v_line_discount, v_promo_name, v_expected_discount;
      end if;
    end if;
    -- v_unit_price, which is products.price_cents unless this line was agreed.
    -- The promotion arithmetic above deliberately stays on
    -- v_product.price_cents: an offer is a reduction off the LIST price, and
    -- the two can never meet on one line anyway -- the guard above refuses it.
    --
    -- IN BIGINT, AND FOR EVERY LINE. The agreed price has been bounded before
    -- its own multiplication since 20260929000000; a line priced from the SHELF
    -- was not bounded at all, and a product priced 1,500,000,000 sold three at a
    -- time overflowed this very statement in 32 bits and raised a bare
    -- `integer out of range` from mid-loop. The widening costs nothing and the
    -- narrowing below cannot fail, because the bound has already passed.
    v_line_cents := v_unit_price::bigint * v_qty - v_line_discount;
    -- c_max_int_cents, NOT c_max_line_cents. This is where `v_line integer`
    -- actually stops holding the answer, so a line that trips this did not work
    -- before either -- it crashed. Bounding an ordinary till line at the
    -- 1,000,000,000 an agreed price may reach would refuse sales the register
    -- has always accepted; see the header.
    if v_line_cents > c_max_int_cents then
      raise exception 'this line is out of range: % at % cents x % is more than the % cents one line may carry',
        v_product.name, v_unit_price, v_qty, c_max_int_cents;
    end if;
    -- After the ceiling, before the narrowing. A negative line cannot be past
    -- the ceiling, so the order between these two is free -- and this way the
    -- cast below sits under both of them.
    if v_line_cents < 0 then
      raise exception 'discount exceeds line total for %', v_product.name;
    end if;
    v_line := v_line_cents::integer;

    update public.product_location_stock set stock = stock - v_qty, updated_at = now()
      where product_id = v_product.id and location_id = v_location_id;

    insert into public.sale_items (sale_id, product_id, product_name, unit_price_cents, quantity, line_total_cents, discount_cents, unit_cost_cents, promotion_id, promotion_name)
      -- unit_price_cents is v_unit_price -- the agreed price when there was one.
      -- unit_cost_cents is v_product.cost_cents and MUST STAY SO: cost is what
      -- the shop actually paid, which an agreement about the selling price says
      -- nothing about. Deriving it from the agreed price would misstate COGS
      -- and, through it, every gross-profit figure the shop reads -- and it
      -- would make giving stock away look free. 20260804000000 froze this
      -- column for a reason; the agreed price does not get to unfreeze it.
      values (v_sale_id, v_product.id, v_product.name, v_unit_price, v_qty, v_line, v_line_discount, v_product.cost_cents, v_promo_id, v_promo_name);

    -- THE ACCUMULATION HAS A CEILING TOO, and it is not the same guard as the
    -- line's. Three lines of 1,000,000,000 each pass the per-line bound
    -- individually -- that is what "per line" means -- and then this addition
    -- overflows `v_gross_cents integer` and the caller gets a bare
    -- `integer out of range` raised from the middle of the register's write
    -- path, which is precisely the failure the line bound's comment claimed to
    -- have prevented.
    --
    -- Both operands are widened to bigint for the test, so the test itself
    -- cannot be the thing that overflows, and it happens BEFORE the assignment
    -- rather than after it -- after it there is nothing left to check.
    --
    -- Applied to EVERY line rather than only to agreed ones: an accumulation
    -- overflows the same way whether the prices came from the cart or from the
    -- shelf.
    --
    -- AT c_max_int_cents, WHICH IS THE CORRECTION. The first wave of this fix
    -- put 1,000,000,000 here -- the agreed price's ceiling -- and so refused a
    -- plain till sale of a 1,500,000,000 product that the register had always
    -- accepted, because 1,500,000,000 fits in an integer and nothing overflowed.
    -- The bound belongs where the arithmetic breaks, not where a caller's number
    -- is distrusted: 2,147,483,647 is the last total `v_gross_cents integer` can
    -- hold, so a cart that trips this got `integer out of range` before and gets
    -- a sentence now, and no cart that worked is touched. Baseline checks 23 and
    -- 24 are the two sides of that.
    if v_gross_cents::bigint + v_line_cents > c_max_int_cents then
      raise exception 'this sale is out of range: adding % for % takes it past the % cents one sale may carry',
        v_line, v_product.name, c_max_int_cents;
    end if;
    v_gross_cents := v_gross_cents + v_line;
    v_item_count := v_item_count + v_qty;
  end loop;

  if v_item_count = 0 then
    raise exception 'cannot complete a sale with no items';
  end if;

  v_total_cents := v_gross_cents - v_discount_cents;
  if v_total_cents < 0 then
    raise exception 'discount exceeds sale total';
  end if;

  if v_points_redeemed > 0 then
    -- The lock that makes the balance check atomic across two registers. Taken
    -- on the counter rather than by summing the ledger, for the reason
    -- shop_usage_counters gives: a sum is neither O(1) nor safe under
    -- concurrency -- both tills read the same balance and both pass.
    select points_balance into v_balance from public.customers
      where id = p_customer_id and shop_id = p_shop_id
      for update;
    if v_balance is null then
      raise exception 'customer % not found in this shop', p_customer_id;
    end if;
    -- RESTORED. This guard shipped in 20260820000100 and was dropped when
    -- 20260822000000 copied complete_sale forward from an older ancestor; it has
    -- been missing ever since, so the maturation window has not actually been
    -- enforced. verify-loyalty check 11 has been failing on main because of it.
    --
    -- Only points that have finished maturing can be spent. Computed inside the
    -- lock so a redemption cannot race a sale that is still earning, and
    -- restricted to `earn` rows -- a reversal or a manual grant is not made to
    -- wait again. The points THIS sale is about to earn are written further
    -- down, so they correctly play no part in its own redemption.
    select coalesce(sum(l.delta_points), 0) into v_pending_points
      from public.customer_points_ledger l
     where l.customer_id = p_customer_id
       and l.reason = 'earn'
       and l.created_at > now() - make_interval(days => coalesce(v_grace_days, 0));
    v_points_available := greatest(v_balance - v_pending_points, 0);

    if v_points_redeemed > v_points_available then
      -- Reported as balance-minus-available rather than the raw sum of earn
      -- rows in the window: spends and clawbacks have already reduced the
      -- balance, so the raw figure can exceed it and read as nonsense ("160 of
      -- 70 still maturing"). This way available + on-hold always equals the
      -- balance the customer can see.
      if v_balance > v_points_available then
        raise exception 'customer has % points available to spend (% of % still maturing), cannot redeem %',
          v_points_available, v_balance - v_points_available, v_balance, v_points_redeemed;
      else
        raise exception 'customer has % points, cannot redeem %', v_points_available, v_points_redeemed;
      end if;
    end if;

    v_redeem_cents := v_points_redeemed * v_cents_per_point;

    -- Raise rather than clamp. The client has already collected payment against
    -- a total computed with this redemption, so quietly spending fewer points
    -- would leave the payments short and fail the equality check below with a
    -- message that names neither the cause nor the fix.
    if v_redeem_cents > v_total_cents then
      raise exception 'redeeming % points is worth % cents, more than the % cents owed',
        v_points_redeemed, v_redeem_cents, v_total_cents;
    end if;

    v_total_cents := v_total_cents - v_redeem_cents;
  end if;

  -- ── A QUOTED TOTAL ALREADY HAS THE TAX IN IT ──────────────────────
  --
  -- THE TAX IS WHAT ROUNDS. Extracting tax from a total is not the inverse of
  -- adding it, and the two natural ways to write the extraction disagree by a
  -- whole cent wherever the exact net lands on a half:
  --
  --     round the TAX   tax = round(gross * rate / (100 + rate))
  --     round the NET   tax = gross - round(gross * 100 / (100 + rate))
  --
  -- 1001 cents at 4% is such a figure -- the net is exactly 962.5 and the tax
  -- exactly 38.5 -- and the two answers are 39 and 38. This function rounds the
  -- TAX, for one reason that is not a preference: eight lines below, the till
  -- has always computed `round(v_total_cents * v_tax_rate / 100)`, which rounds
  -- the TAX and lets the other side carry the remainder. A quoted sale rounds
  -- the same quantity in the same direction, or a shop reconciling its 2100
  -- against its 4000 finds a cent that appears or vanishes depending on which
  -- door the sale came in through. Baseline check 27a pins 39 at the figure
  -- where the two disagree; 27b pins the round trip, where they do not.
  --
  -- SUBTRACTED FROM THE RUNNING TOTAL RIGHT HERE, which is what makes the rest
  -- of this function need no further branch. From this statement on
  -- v_total_cents is the tax-EXCLUSIVE merchandise figure in both directions,
  -- so the loyalty earn below is the SAME LINE it has always been, and the
  -- `v_total_cents + v_tax_cents` at the foot of the block puts the quoted
  -- figure back exactly. Nothing is lost in the round trip: the same integer is
  -- taken off and added back on.
  --
  -- AFTER THE REDEMPTION, deliberately. The tax is on what the customer
  -- actually pays, and a redemption reduces that -- the same order the till
  -- takes (baseline check 8 pins 178 rather than 180 for exactly this reason).
  --
  -- `coalesce(v_tax_rate, 0) > 0` rather than v_tax_enabled alone, and it
  -- matches the permission test above statement for statement. A shop with tax
  -- enabled and no rate set has nothing to extract, and dividing by
  -- `100 + NULL` would make the tax NULL, the total NULL, and the sale fail on
  -- a not-null constraint with nothing in the message about tax.
  if v_prices_include_tax and coalesce(v_tax_enabled, false) and coalesce(v_tax_rate, 0) > 0 then
    v_included_tax_cents := round(v_total_cents * v_tax_rate / (100 + v_tax_rate))::integer;
    v_tax_cents := v_included_tax_cents;
    v_total_cents := v_total_cents - v_included_tax_cents;
  end if;

  -- Earned on merchandise actually paid for in money: after every discount
  -- including the redemption, and before tax. Rounded to the nearest whole
  -- point, so $19.99 earns 20.
  --
  -- UNCHANGED, AND THAT IS THE DECISION. This line has always run before the
  -- tax was added, so a counter sale has always earned on the TAX-EXCLUSIVE
  -- figure -- that is not a preference either, it is what the register does.
  -- Because the block above has already taken the quoted tax back out of
  -- v_total_cents, a pre-quoted sale reaches this same line with the same kind
  -- of figure: the merchandise, without the state's share. 2400 quoted
  -- inclusive at 5% earns on 2286 and gives 23 points, where earning on the
  -- quote would give 24. Baseline check 28 is that point.
  if v_loyalty_active then
    v_points_earned := round(v_total_cents * v_points_per_usd / 100)::integer;
  end if;

  -- ...and on an ordinary till sale the tax is added ON TOP, exactly as it was
  -- before this migration. `and not v_prices_include_tax` is the whole of the
  -- change here: a quoted sale has already had its tax settled above, and
  -- taxing it again would charge the customer more than the figure they agreed
  -- to -- which is the entire thing this migration exists to stop.
  if v_tax_enabled and not v_prices_include_tax then
    v_tax_cents := round(v_total_cents * v_tax_rate / 100)::integer;
  end if;
  -- Unconditional, and it is what closes the round trip. On a quoted sale
  -- v_tax_cents is the figure taken off four statements ago, so this restores
  -- the customer's quote to the cent; on every other sale it is the tax just
  -- computed, added on top as always; and on a sale with no tax at all it adds
  -- zero, as always.
  v_total_cents := v_total_cents + v_tax_cents;

  for v_payment in select * from jsonb_array_elements(p_payments) loop
    if (v_payment->>'method') not in ('cash','zaad','edahab','other') then
      raise exception 'invalid payment method %', v_payment->>'method';
    end if;
    if (v_payment->>'amount_cents')::integer <= 0 then
      raise exception 'payment amount must be greater than zero';
    end if;
    v_payments_total := v_payments_total + (v_payment->>'amount_cents')::integer;

    insert into public.sale_payments (sale_id, method, amount_cents, tendered_cents, customer_name, customer_phone, currency_code, exchange_rate, foreign_amount_cents, foreign_change_cents)
      values (
        v_sale_id,
        v_payment->>'method',
        (v_payment->>'amount_cents')::integer,
        (v_payment->>'tendered_cents')::integer,
        v_payment->>'customer_name',
        v_payment->>'customer_phone',
        nullif(v_payment->>'currency_code', ''),
        (v_payment->>'exchange_rate')::numeric,
        (v_payment->>'foreign_amount_cents')::integer,
        (v_payment->>'foreign_change_cents')::integer
      );
  end loop;

  -- Over-payment is still always wrong: a till that takes more than the bill
  -- has a bug, not a credit. Change is `tendered_cents`, not a bigger payment.
  if v_payments_total > v_total_cents then
    raise exception 'payments total % is more than sale total %', v_payments_total, v_total_cents;
  end if;

  -- Under-payment is a decision, and it has to be an explicit one made against
  -- a named customer. Without BOTH, this is exactly the accident the old
  -- unconditional guard existed to catch: a client that miscounted its own
  -- split and would otherwise have quietly written off the difference.
  if v_payments_total < v_total_cents then
    if not coalesce(p_allow_balance, false) then
      raise exception 'payments total % does not match sale total %', v_payments_total, v_total_cents;
    end if;
    if p_customer_id is null then
      raise exception 'a sale can only be left unpaid against a customer';
    end if;
  end if;

  -- Points are earned on money taken, not on goods handed over. A sale left on
  -- account earns nothing yet; settle_sale_balance credits it when the last of
  -- the money arrives, recomputed from this sale's own frozen rate.
  if v_payments_total < v_total_cents then
    v_points_earned := 0;
  end if;

  update public.sales set
    total_cents = v_total_cents,
    item_count = v_item_count,
    tax_cents = v_tax_cents,
    tax_rate_percent = case when v_tax_enabled then v_tax_rate else null end,
    points_redeemed = v_points_redeemed,
    points_redeemed_cents = v_redeem_cents,
    points_earned = v_points_earned,
    loyalty_points_per_usd = case when v_loyalty_active then v_points_per_usd else null end,
    -- Null while anything is still owed. This is the column customer_balances
    -- filters on, so a sale that forgets to stamp it never leaves the list.
    settled_at = case when v_payments_total >= v_total_cents then now() else null end
  where id = v_sale_id;

  -- Two rows, never one net row. "Spent 200, earned 3" is what a customer
  -- querying their balance needs to see; a net -197 hides both facts and
  -- answers no question anyone actually asks.
  --
  -- Written after the payments check, so a sale that gets refused moves no
  -- points.
  if v_points_redeemed > 0 then
    insert into public.customer_points_ledger
      (shop_id, customer_id, sale_id, delta_points, reason, cents_per_point, created_by)
      values (p_shop_id, p_customer_id, v_sale_id, -v_points_redeemed, 'redeem',
              v_cents_per_point, auth.uid());
  end if;
  if v_points_earned > 0 then
    insert into public.customer_points_ledger
      (shop_id, customer_id, sale_id, delta_points, reason, points_per_usd, created_by)
      values (p_shop_id, p_customer_id, v_sale_id, v_points_earned, 'earn',
              v_points_per_usd, auth.uid());
  end if;

  -- ── The posting side ────────────────────────────────────────────────────
  --
  -- Inside the same transaction, deliberately: a sale that is recorded but not
  -- posted is a books-that-do-not-tie bug that only shows up at month end, and
  -- the shop has no way to find which sale it was. Failing the sale is louder
  -- and rarer.
  --
  -- p_source => 'sale', never 'manual'. post_journal_entry gates the manual
  -- source on ledger.post; a cashier holds pos.access and must not need more.

  -- COGS from the cost FROZEN on each line at sale time, never
  -- products.cost_cents -- otherwise a restock tomorrow rewrites this sale's
  -- cost, and with it every closed month's gross profit. That freeze is what
  -- 20260804000000 exists for.
  --
  -- Uncosted lines contribute nothing rather than zero. isUncosted() is careful
  -- that null and zero are different answers: a free sample really does cost
  -- nothing; an unpriced product is a question nobody answered. (sum() ignores
  -- nulls anyway; the filter states the intent for the next reader.)
  select coalesce(sum(si.unit_cost_cents::bigint * si.quantity), 0)
    into v_cogs_cents
    from public.sale_items si
   where si.sale_id = v_sale_id and si.unit_cost_cents is not null;

  -- Every discount taken on a LINE -- a cashier's typed amount and, far more
  -- often, a promotion. Read back off sale_items because there is no running
  -- total of it in this function: the item loop folds each line's discount
  -- straight into v_line (`price_cents * qty - v_line_discount`) before adding
  -- it to v_gross_cents, so by the time control reaches here v_gross_cents is
  -- already NET of it and the figure is unrecoverable from the variables.
  --
  -- sale_items.discount_cents is the per-line discount as written six lines
  -- into the loop's insert; it is 0, never null (0013 added it `not null
  -- default 0`), so no coalesce is needed inside the sum.
  select coalesce(sum(si.discount_cents), 0)
    into v_item_discount_cents
    from public.sale_items si
   where si.sale_id = v_sale_id;

  -- One debit line per payment, against the account that method maps to. A
  -- single lumped line would make the drawer and the wallet impossible to
  -- reconcile separately, which is most of what a cash position is for.
  select coalesce(jsonb_agg(jsonb_build_object(
           'code',         public.account_code_for_payment_method(sp.method),
           'amount_cents', sp.amount_cents,
           'memo',         'Payment by ' || sp.method)), '[]'::jsonb)
    into v_lines
    from public.sale_payments sp
   where sp.sale_id = v_sale_id and sp.amount_cents <> 0;

  -- What the customer still owes, which the guards above have already accepted
  -- as an under-payment made on purpose against a named customer. Both
  -- operands are final here: the payments loop has closed and the tax has been
  -- folded into v_total_cents.
  v_owed_cents := v_total_cents - v_payments_total;
  if v_owed_cents > 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'code', '1100', 'amount_cents', v_owed_cents, 'memo', 'Left on account'));
  end if;

  -- ALL THREE discounts are shown GROSS: revenue is credited at list price and
  -- every reduction is its own debit to 4200. Netting a discount into 4000
  -- would hide what the shop gave away, which is the one number a discount
  -- report exists to show.
  --
  -- The three are not symmetrical in this function, and the first version of
  -- this block got that wrong:
  --
  --   * v_discount_cents  -- the ORDER-level discount. Subtracted from
  --     v_gross_cents further down, so v_gross_cents is gross with respect to
  --     it and it has to be added back here.
  --   * v_redeem_cents    -- loyalty points spent. Same: subtracted after
  --     v_gross_cents is final.
  --   * v_item_discount_cents -- LINE and PROMOTION discounts. NOT the same.
  --     The item loop computes `v_line := price_cents * qty - v_line_discount`
  --     and accumulates THAT, so v_gross_cents is already net of it.
  --
  -- Crediting 4000 with a bare v_gross_cents therefore understated revenue by
  -- every promotion the shop ran and left 4200 reading zero for a shop whose
  -- discounts are all promotions -- which is the app's main discount
  -- mechanism. One item at 5000 with a 1000 promotion, no tax, 4000 cash,
  -- posted `Dr 1000 4000 / Cr 4000 4000` and no 4200 line at all.
  --
  -- So: revenue at list is v_gross_cents + v_item_discount_cents, and the
  -- contra is all three discounts together.
  --
  -- Still balanced by construction, and this is the whole proof. Writing D for
  -- v_discount_cents, R for v_redeem_cents, I for v_item_discount_cents, G for
  -- v_gross_cents and T for v_tax_cents, the function computes
  --     v_total_cents = G - D - R + T
  -- and the debits are the money in (payments + receivable = v_total_cents)
  -- plus the contra (D + R + I), which is G + T + I. The credits are revenue
  -- (G + I) plus tax (T), which is the same figure. The COGS pair below is a
  -- self-balancing debit/credit of one amount and does not disturb it.
  --
  -- A redemption lands in 4200 alongside the discounts rather than drawing down
  -- 2300 Loyalty Points Liability: posting the redemption as a liability
  -- drawdown without also posting the earn side would drive 2300 negative on
  -- the very first redemption. The earn side is a later phase's work.
  if (v_discount_cents + v_redeem_cents + v_item_discount_cents) > 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'code', '4200', 'amount_cents', v_discount_cents + v_redeem_cents + v_item_discount_cents,
      'memo', 'Discounts and points'));
  end if;

  --
  -- LESS THE TAX THAT WAS INSIDE THE QUOTE, which is zero on every sale that
  -- did not set p_prices_include_tax and therefore changes nothing for any
  -- caller that existed before this migration.
  --
  -- On a quoted sale it is not optional and it is not a presentation choice.
  -- The customer handed over G - D - R; the debits are that money plus the
  -- contra D + R + I, which is G + I. Crediting revenue at G + I while also
  -- crediting the state's T leaves the entry heavier on the credit side by
  -- exactly T, and post_journal_entry refuses an entry that does not balance --
  -- so a tax-charging shop could not complete a quoted order at all. Revenue is
  -- G + I - T and the two sides are G + I again.
  --
  -- It also happens to be the right answer rather than merely the balancing
  -- one: tax collected for the state was never the shop's revenue, which is the
  -- same reason the ordinary path credits 4000 with the goods and not with the
  -- total. The three DISCOUNTS stay at their quoted figures on 4200 -- what the
  -- shop actually took off the price it advertised -- rather than being split
  -- into a net and a tax share of their own. A discount report exists to say
  -- what was given away, and that is the figure that was given away.
  if (v_gross_cents + v_item_discount_cents - v_included_tax_cents) > 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'code', '4000', 'amount_cents', -(v_gross_cents + v_item_discount_cents - v_included_tax_cents), 'memo', 'Sale at list'));
  end if;

  if v_tax_cents > 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'code', '2100', 'amount_cents', -v_tax_cents, 'memo', 'Sales tax'));
  end if;

  -- Omitted entirely when zero, not posted as a zero pair: journal_lines
  -- carries check (amount_cents <> 0), so a zero line fails the whole sale.
  if v_cogs_cents > 0 then
    v_lines := v_lines || jsonb_build_array(
      jsonb_build_object('code', '5000', 'amount_cents',  v_cogs_cents, 'memo', 'Cost of goods sold'),
      jsonb_build_object('code', '1200', 'amount_cents', -v_cogs_cents, 'memo', 'Stock sold'));
  end if;

  -- The shop's local date for this sale.
  --
  -- `at time zone 'Africa/Mogadishu'`, never a bare ::date. A bare cast resolves
  -- in the SESSION's timezone, which is UTC on Supabase -- so a sale at 01:30
  -- local on the 1st (22:30 UTC on the last day of the month before) was dated
  -- into the previous month while src/lib/period.ts, which buckets the sales
  -- report in device-local time, put it in this one. The two disagreed
  -- permanently: once the earlier period closes, the entry cannot be re-dated.
  --
  -- A platform constant rather than a per-shop column, on purpose. See the
  -- header of this migration for why there is no shops.timezone and what would
  -- have to change if there ever is one.
  v_entry_date := (coalesce(p_created_at, now()) at time zone 'Africa/Mogadishu')::date;

  -- Read, rather than caught. open_period_for raises for any non-open period,
  -- and catching that exception would also swallow an unbalanced entry, an
  -- unknown account code, or a missing chart of accounts -- and quietly retry
  -- them into the current month as though the only thing wrong were the date.
  select status into v_period_status
    from public.accounting_periods
   where shop_id = p_shop_id and v_entry_date between starts_on and ends_on;

  -- No row means open_period_for will create it open, so only an EXISTING
  -- non-open period redirects. Getting this backwards -- treating a missing row
  -- as shut -- would redate every sale in a month nobody has traded in yet,
  -- which is most backdated CSV imports.
  if v_period_status is not null and v_period_status <> 'open' then
    v_posted_date := (now() at time zone 'Africa/Mogadishu')::date;
  else
    v_posted_date := v_entry_date;
  end if;

  -- A SALE THAT MOVES NO MONEY POSTS NOTHING, rather than failing at the till.
  --
  -- Every line above is conditional, so v_lines really can come out empty: a
  -- basket of free samples (price 0, no frozen cost), no tax, no discount, and
  -- left on account against a named customer, which p_allow_balance
  -- (20260831000100) makes legal. item_count > 0, so the "a sale must have at
  -- least one item" guard passes; v_total_cents is 0, so there is no payment
  -- and no receivable either.
  --
  -- Handed to post_journal_entry, that raised
  -- `A journal entry needs at least two lines; this one has 0.` and took the
  -- whole sale down -- a NEW failure, at the till, for an operation that worked
  -- before this branch. The honest answer is that nothing happened in
  -- accounting terms and there is nothing to record: journal_lines carries
  -- check (amount_cents <> 0), so there is no zero-value entry to write even if
  -- one were wanted.
  --
  -- sales.journal_entry_id therefore stays NULL on such a sale, permanently and
  -- on purpose. Task 8's backfill applies the SAME predicate rather than trying
  -- to replay it later (20260908000700, step 1's sales map) -- without that, one
  -- historical giveaway aborts an entire shop's replay at step 7.
  --
  -- Checked on the array rather than on v_total_cents: the six line groups are
  -- what decide, and a sale can carry a zero total and still move money (a
  -- 100%-discounted line credits 4000 and debits 4200, and a costed line posts
  -- the 5000/1200 pair either way).
  if jsonb_array_length(v_lines) > 0 then
    -- The description carries the sale id, so the link is readable in both
    -- directions. sales.journal_entry_id gets you from the sale to the entry; a
    -- bare 'Sale' got you nowhere back, and a journals list of four hundred rows
    -- all reading 'Sale' is not a journal anybody can audit. Task 8's backfill
    -- has to reconcile replayed entries against their source rows and wants the
    -- same link.
    --
    -- And when the two dates differ, it carries the sale's TRUE date and the
    -- status that pushed it here. Without that, the only record of why an August
    -- sale is sitting in October lives on the source row, and the journal -- the
    -- thing an auditor actually reads -- shows an unexplained October entry.
    v_entry_id := public.post_journal_entry(
      p_shop_id,
      v_posted_date,
      'Sale ' || v_sale_id::text
        -- coalesce, even though the branch above cannot set v_posted_date <>
        -- v_entry_date while v_period_status is NULL. `||` with a NULL operand
        -- yields NULL for the WHOLE expression, so if that invariant is ever
        -- broken by an edit up there the description becomes NULL and
        -- post_journal_entry refuses the sale with `A journal entry needs a
        -- description.` -- an error about descriptions for a bug about dates,
        -- on the hot path. Found by mutating the redirect condition to `if true`.
        || case when v_posted_date <> v_entry_date
                then ' (sold ' || to_char(v_entry_date, 'YYYY-MM-DD')
                     || '; that period is ' || coalesce(v_period_status, 'not open')
                     || ', so it is recognised here)'
                else '' end,
      v_lines,
      v_location_id,
      'sale');

    update public.sales set journal_entry_id = v_entry_id where id = v_sale_id;
  end if;
  -- ── end posting side ────────────────────────────────────────────────────

  return v_sale_id;
end;
$$;
-- ── complete_storefront_order, re-created in full ─────────────────────────

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
-- ── The grants ────────────────────────────────────────────────────────────
--
-- Postgres grants EXECUTE to PUBLIC on every new function, so `grant execute`
-- on its own is a no-op that says nothing about who may call these -- and on a
-- SECURITY DEFINER function that runs as the owner, PUBLIC includes anon.
-- Neither signature changed here, so `create or replace` kept the existing
-- ACLs and these four statements restate rather than repair; the order is the
-- one 20260924000100_storefront_public_read.sql:103-109 establishes, and it was
-- checked empirically rather than assumed (against a scratch function granted
-- to `authenticated` alone, has_function_privilege('anon', ..., 'EXECUTE')
-- answers TRUE until the revoke runs, and FALSE after it).
revoke execute on function public.complete_sale(uuid, jsonb, jsonb, text, text, text, text, integer, uuid, timestamptz, uuid, integer, uuid, boolean, boolean) from public;
grant execute on function public.complete_sale(uuid, jsonb, jsonb, text, text, text, text, integer, uuid, timestamptz, uuid, integer, uuid, boolean, boolean) to authenticated;

revoke execute on function public.complete_storefront_order(uuid, text) from public;
grant execute on function public.complete_storefront_order(uuid, text) to authenticated;
