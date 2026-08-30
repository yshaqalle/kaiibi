-- An order can be amended.
--
-- Until now a shop short on stock had exactly one move: cancel the whole
-- order. `checkOrderFulfilment` would tell them the order cannot be filled,
-- the row would say "short 2", and the detail sheet offered "source more
-- stock, or cancel it below". A customer who ordered five bags of rice when
-- there are three got nothing at all. There was also no way to change a
-- quantity the customer had second thoughts about, or to fix a mistyped phone
-- number, or to correct a landmark the driver cannot find.
--
-- This is `amend_order`, and an `order_amendments` table that records every
-- use of it.
--
--
-- ## Why this is an RPC and not a client write
--
-- `authenticated` has no insert, update or delete on `orders` or
-- `order_items` -- 20260928000300_orders_write_lockdown.sql:100 revoked all
-- three after the money-handling review found a shop member could reach
-- `orders` through the "own orders" RLS policy and complete an order with an
-- arbitrary sale attached and nothing posted. That lockdown is what makes
-- every write to an order go through a `security definer` function, and this
-- is the second such function. It does not relax the lockdown by one
-- privilege, and verify-order-amendments check 15 re-proves the lockdown is
-- still there afterwards.
--
--
-- ## THE PRICE: a choice the shop makes, not a rule this function imposes
--
-- The plan this migration implements said re-pricing at today's shelf price
-- was MANDATORY, on the grounds that `complete_sale` prices every line from
-- `products.price_cents` and discards the snapshot it is passed, so an amend
-- that kept the agreed price would build an order that could never be
-- completed -- it would raise `order_total_changed` at the till.
--
-- THAT WAS TRUE, AND IT IS NOT TRUE ANY MORE. It cites
-- 20260908000300_sale_entry_date.sql:363, which is precisely the line
-- 20260929000000_complete_sale_agreed_price.sql was written to change. Today:
--
--   * complete_sale resolves a line as
--     `v_unit_price := coalesce(v_agreed_price, v_product.price_cents)`
--     (20261011000000:640) -- the agreed price wins whenever one is supplied.
--   * complete_storefront_order supplies one for every line, as
--     `'agreed_unit_price_cents', oi.unit_price_cents` (20261011000000:1362),
--     over the comment "THE ORDER'S OWN NUMBERS ARE NOW AUTHORITATIVE".
--   * `order_total_changed` no longer fires for a re-priced product at all.
--     What is left of it is the order ROW disagreeing with the order's own
--     LINES (20261011000000:1477).
--   * verify-order-transitions check 46 pins the whole thing: a product
--     re-priced 700 -> 1300 completes, and the sale is filed at the agreed
--     700.
--
-- So the constraint that was supposed to force re-pricing does not exist, and
-- BOTH answers complete cleanly. Which turns a hard requirement back into
-- what it always really was -- a question about what the shop owes the
-- customer -- and that question is the shop's to answer, not this function's.
--
-- `p_pricing` therefore takes two values and defaults to the honest one:
--
--   'agreed'  (default) -- every surviving line keeps the
--               order_items.unit_price_cents it was quoted at. Reducing five
--               bags to three charges three times the price the customer
--               agreed to. Correcting a phone number does not touch the money
--               at all.
--   'current' -- every surviving line is re-priced from today's
--               products.price_cents. A shop that has genuinely re-priced,
--               and has spoken to the customer, can say so.
--
-- An unrecognised value is REFUSED (`invalid_pricing`) rather than falling
-- back to either one. A silent fallback would let a client typo choose a
-- price on the customer's behalf, which is the one outcome both modes exist
-- to prevent. Checks 7a and 7b are the two modes over the identical fixture,
-- and 7b's third case is the typo.
--
-- 'current' IS A ONE-WAY DOOR, and this is worth stating because the names
-- suggest otherwise. There is exactly one place an order's prices live --
-- order_items.unit_price_cents -- and re-pricing rewrites it. So a LATER
-- amend at 'agreed' keeps the re-priced figures; it does not restore the
-- original quote, because after the first re-price nothing in `orders` or
-- `order_items` still remembers it. That is the correct behaviour for a
-- function whose whole contract is "the order's own numbers are
-- authoritative", and it is not a loss of information: order_amendments
-- carries `before` for every amend and a `pricing` column saying which ones
-- re-priced, so the original is always readable. But there is no undo
-- through this function, and the sheet's own wording says so rather than
-- promising one.
--
-- The mode is written onto the amendment row as its own column, not buried in
-- the `after` blob, so "did this shop re-price this order?" is one query and
-- not a JSON scan.
--
--
-- ## Why p_pricing is NOT the mistake 20261011000000 was written to undo
--
-- That migration removed `p_require_register boolean default true` from
-- `complete_sale`. The argument for it had been that the default left every
-- existing caller unchanged; the hole was that a function granted to
-- `authenticated` is exposed over PostgREST, so EVERY parameter it declares
-- is a field any caller can send. `=> false` defeated the shop's setting, and
-- `=> null` defeated it too, because `if NULL and ...` is NULL and the guard
-- never fired at all.
--
-- The rule that came out of it is precise, and it is worth restating exactly:
-- NO PARAMETER MAY DECIDE WHO IS ALLOWED TO DO WHAT. Authorization is read
-- from the session -- `is_shop_member`, `shop_has_module`,
-- `has_shop_permission` -- never from an argument.
--
-- `p_pricing` decides no such thing. Every caller reaching it has already
-- passed all three of those gates; it chooses between two outcomes a shop
-- holding `sales.edit` is entitled to choose between either way, and the
-- choice is recorded on a row the shop can read back. A caller who sets it to
-- 'current' can gain nothing they could not gain by amending twice. That is
-- the whole difference: `p_require_register` was an off switch for a rule,
-- and this is a business decision with an audit trail.
--
-- Both of its values are refused for a caller who fails the gates, which is
-- what check 14 proves in both directions -- the member without the
-- permission is refused, AND the member with it succeeds, so the check cannot
-- pass against a function that refuses everyone.
--
--
-- ## The permission is `sales.edit`
--
-- There is no `orders.*` or `storefront.*` permission -- the whole list is
-- src/lib/permissions.ts:52-98, and `/orders` is gated on `settings.access`
-- while `transition_order` checks only membership. Inventing `orders.amend`
-- would need a roles migration and a settings screen to set it in, and every
-- existing role would start without it, so every shop would find amending
-- broken until someone edited a role.
--
-- `sales.edit` is "Edit or delete a past sale" (0020_default_roles.sql:12
-- seeds it onto Manager). An amend changes what a customer owes, which is the
-- same kind of authority over the same kind of money, and a shop that trusts
-- someone to edit a completed sale plainly trusts them to reduce an open
-- order. It is the nearest existing analogue and it needs no migration to
-- take effect.
--
-- ONE ODDITY IS LEFT STANDING, deliberately, because fixing it is not this
-- migration's business: `transition_order` lets any shop member CANCEL an
-- order with no permission at all. So amending an order down to three bags
-- now needs `sales.edit`, while binning it entirely needs nothing. That is
-- the wrong way round. Raising the cancel path is a change to a function this
-- migration does not otherwise touch, with its own checks to write and its
-- own risk of locking a shop out of a flow it uses daily -- it belongs in its
-- own migration, and it is written up in the handoff.
--
--
-- ## The reason is required, and enforced twice
--
-- `cancellation_reason` is enforced by the transition trigger AND by
-- `orders_cancellation_reason_required` (20260928000100:81), a CHECK on the
-- table. The belt-and-braces is deliberate there and it is copied here: the
-- function refuses a blank reason with a typed error a shopkeeper can read,
-- and `order_amendments_reason_required` refuses one at the table regardless
-- of which writer got there.
--
-- TWO REASONS, AND ONLY ONE OF THEM TRAVELS. `reason` is internal. Real ones
-- are blunt -- "only three bags, told her on the phone" -- and it is written
-- for the shop to read weeks later. `customer_note` is the optional, separate
-- field that Part 3's share link may show. Nothing in this migration sends
-- either anywhere; the separation exists so that when Part 3 does, the blunt
-- one is structurally incapable of being the one it picks up.
--
--
-- ## An amend may not ADD a product the customer never ordered
--
-- The spec drew adding as allowed and left it as an open question. It is
-- refused here, with `order_line_not_in_order`.
--
-- "We sent you less than you ordered" and "we sent you something you never
-- asked for" are different conversations, and only the first is a reduction
-- of a promise the customer already made. The second is a new agreement, and
-- an amend is precisely the operation that happens WITHOUT asking the
-- customer -- there is no confirmation step in this part, and the shop can
-- change the total on their own.
--
-- It is also incoherent with the pricing choice above. A line the customer
-- never ordered has no agreed price to honour, so 'agreed' would have to
-- silently price it at today's shelf and the order would carry two pricing
-- regimes at once. Refusing keeps every line in an amended order traceable to
-- a price the customer was actually quoted.
--
-- This is the reversible direction. Allowing adds later is additive; orders
-- that already carry added lines cannot be un-added. Part 3's confirmation
-- flow is where a substitution can be AGREED to, and that is where it should
-- land if it lands at all.
--
--
-- ## The delivery fee is re-resolved, never accepted
--
-- Switching an order to delivery re-reads the fee from this shop's own
-- `storefront_delivery_areas` row, exactly as place_storefront_order does
-- (20260927000000:360), and the area is stored from `a.name` rather than from
-- what the caller typed to find it -- same reasoning as that function's own
-- comment. A `p_delivery_fee_cents` parameter would be the register guard all
-- over again in the one place it would cost real money: a caller who can name
-- the fee can name zero. There is no such parameter and there must never be.
--
-- Switching to collect zeroes the fee AND clears the area, because
-- `orders_delivery_matches_fulfilment` requires both and a partial answer
-- would fail the constraint from inside the function rather than being
-- refused cleanly.
--
--
-- ## The per-line ceiling is checked HERE
--
-- Every line of a storefront fulfilment now reaches complete_sale as
-- `agreed_unit_price_cents`, which carries a per-line ceiling of
-- 1,000,000,000 cents (20260929000050). `order_items.line_total_cents` is a
-- plain `integer`, so a line ABOVE that ceiling and below int32 is perfectly
-- storable -- and an amend that stored one would build an order that fails at
-- the till, in complete_sale's own English, at the worst possible moment.
-- Checking it here turns that into a sentence in the amend sheet. Check 16.
--
-- The same argument one level up: `orders.subtotal_cents` is `integer`, and
-- several lines each under the per-line ceiling can still sum past int32. Left
-- unchecked that surfaces as a bare `integer out of range` raised from the
-- middle of this function -- the exact failure 20260929000050's header is
-- about. Check 19.

create table public.order_amendments (
  id         uuid primary key default gen_random_uuid(),
  order_id   uuid not null references public.orders(id) on delete cascade,
  amended_at timestamptz not null default now(),
  amended_by uuid not null,

  -- INTERNAL. Written for the shop, read by the shop, weeks later. Real ones
  -- are blunt. This must never reach a customer -- Part 3 shows the link, and
  -- it shows customer_note, never this.
  reason        text not null,
  customer_note text,

  -- Which price the shop chose. Its own column rather than a key inside
  -- `after`, so "has this order been re-priced since the customer agreed to
  -- it?" is answerable without scanning JSON.
  pricing text not null check (pricing in ('agreed', 'current')),

  before jsonb not null,
  after  jsonb not null,

  -- The braces behind the function's own guard, the same pairing
  -- orders_cancellation_reason_required has with the transition trigger.
  constraint order_amendments_reason_required check (btrim(reason) <> '')
);

create index order_amendments_order_id_idx
  on public.order_amendments (order_id, amended_at desc);

alter table public.order_amendments enable row level security;

-- The shop may READ its own amendment history -- it is the shop's record of
-- its own decisions, and the sheet will want to show it. Writes have no
-- policy and no grant at all: `amend_order` is SECURITY DEFINER and writes as
-- this table's owner, for whom RLS does not bind (FORCE ROW LEVEL SECURITY is
-- deliberately not set), so the only way a row lands here is through the
-- function. Same posture as storefront_order_completions (20260928000500),
-- one privilege wider on the read side and no wider on the write side.
create policy order_amendments_member_read on public.order_amendments
  for select using (
    exists (
      select 1 from public.orders o
      where o.id = order_amendments.order_id and public.is_shop_member(o.shop_id)
    )
  );

-- A fresh table in this project already starts with no privilege for
-- anon/authenticated, but 20260818000600's own header records that the
-- supabase_admin-owned default privilege it tried to strip is allowed to fail
-- silently on a managed project. Stated rather than assumed, so a hosted
-- project cannot inherit `grant all` from the original bootstrap default.
revoke all on public.order_amendments from anon, authenticated;
grant select on public.order_amendments to authenticated;

create or replace function public.amend_order(
  p_order_id      uuid,
  p_lines         jsonb,
  p_reason        text,
  p_customer_note text default null,
  p_pricing       text default 'agreed',
  p_fulfilment    jsonb default null,
  p_contact       jsonb default null
) returns public.orders
language plpgsql security definer set search_path = public as $$
declare
  -- complete_sale's own ceiling on an agreed price (20260929000050), restated
  -- rather than imported: there is no function to read it from, and a line
  -- built here that passes it is a line that fails at the till.
  c_max_line_cents constant bigint := 1000000000;
  -- int32, the width of orders.subtotal_cents and orders.total_cents.
  c_max_int_cents  constant bigint := 2147483647;

  v_order    public.orders%rowtype;
  v_actor    uuid    := auth.uid();
  v_reason   text    := btrim(coalesce(p_reason, ''));
  v_note     text    := nullif(btrim(coalesce(p_customer_note, '')), '');
  v_pricing  text    := coalesce(p_pricing, 'agreed');

  v_before   jsonb;
  v_after    jsonb;
  v_new      jsonb   := '[]'::jsonb;
  v_line     jsonb;
  v_pid      uuid;
  v_qty_num  numeric;
  v_qty      bigint;
  v_unit     bigint;
  v_name     text;
  v_subtotal bigint  := 0;

  v_fulfil   text;
  v_area     text;
  v_area_in  text;
  v_landmark text;
  v_fee      integer;

  v_cname    text;
  v_cphone   text;
begin
  -- FOR UPDATE, so two shop phones amending the same order queue instead of
  -- both reading the same lines and the second one silently winning. Same
  -- reasoning as complete_storefront_order's own lock.
  select * into v_order from public.orders where id = p_order_id for update;
  if v_order.id is null then
    raise exception 'order_not_found' using errcode = 'P0001';
  end if;

  -- ── Authorization, all of it read from the session ────────────────────
  if v_actor is null or not public.is_shop_member(v_order.shop_id) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;
  if not public.shop_has_module(v_order.shop_id, 'storefront') then
    raise exception 'module_not_included'
      using errcode = 'P0001',
            detail = json_build_object('module', 'storefront')::text,
            hint = 'Upgrade the plan to make changes here.';
  end if;
  if not public.has_shop_permission(v_order.shop_id, 'sales.edit') then
    raise exception 'sales_edit_required' using errcode = 'P0001';
  end if;

  -- A completed order has a sale posted against it and a
  -- storefront_order_completions row proving which transaction posted it;
  -- rewriting its lines would leave the shop's two records of one
  -- transaction disagreeing forever. A cancelled one is finished.
  if v_order.status in ('completed', 'cancelled') then
    raise exception 'order_not_amendable'
      using errcode = 'P0001',
            detail = json_build_object('status', v_order.status)::text;
  end if;

  if v_reason = '' then
    raise exception 'amendment_reason_required' using errcode = 'P0001';
  end if;
  if v_pricing not in ('agreed', 'current') then
    raise exception 'invalid_pricing'
      using errcode = 'P0001',
            detail = json_build_object('pricing', v_pricing)::text;
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' then
    raise exception 'invalid_lines' using errcode = 'P0001';
  end if;

  -- Two entries for one product is an ambiguous instruction -- "make it 3"
  -- and "make it 5" in the same call -- and picking either one silently is
  -- how an amend charges for a quantity nobody asked for.
  --
  -- BOTH SIDES IGNORE NULLS, and they have to. `count(distinct)` drops them
  -- on its own, so counting every element on the left made a single
  -- null-product line read as a duplicate -- and it was raised HERE, before
  -- the loop could refuse it as `order_product_deleted`, which is the honest
  -- answer for a line whose product is gone. Check 10 caught exactly that.
  if (select count(*) from jsonb_array_elements(p_lines) l
       where l->>'product_id' is not null)
     <> (select count(distinct l->>'product_id') from jsonb_array_elements(p_lines) l) then
    raise exception 'duplicate_line' using errcode = 'P0001';
  end if;

  v_before := jsonb_build_object(
    'subtotal_cents',     v_order.subtotal_cents,
    'delivery_fee_cents', v_order.delivery_fee_cents,
    'total_cents',        v_order.total_cents,
    'fulfilment',         v_order.fulfilment,
    'delivery_area',      v_order.delivery_area,
    'delivery_landmark',  v_order.delivery_landmark,
    'customer_name',      v_order.customer_name,
    'customer_phone',     v_order.customer_phone,
    'lines', coalesce((
      select jsonb_agg(jsonb_build_object(
               'product_id',       oi.product_id,
               'product_name',     oi.product_name,
               'unit_price_cents', oi.unit_price_cents,
               'quantity',         oi.quantity)
             order by oi.product_name)
        from public.order_items oi where oi.order_id = p_order_id), '[]'::jsonb));

  -- ── The lines the order should now stand at ───────────────────────────
  for v_line in select * from jsonb_array_elements(p_lines) loop
    v_pid := nullif(v_line->>'product_id', '')::uuid;

    -- A line whose product was deleted carries product_id null
    -- (`on delete set null`, 20260926000050:136) and cannot be named. Keeping
    -- one builds an order complete_storefront_order refuses outright with
    -- this same code, so it is refused here instead -- omit it and it is
    -- removed, which is the only thing that can be done with it.
    if v_pid is null then
      raise exception 'order_product_deleted' using errcode = 'P0001';
    end if;

    if jsonb_typeof(v_line->'quantity') <> 'number' then
      raise exception 'invalid_quantity' using errcode = 'P0001';
    end if;
    v_qty_num := (v_line->>'quantity')::numeric;
    if v_qty_num < 0 or v_qty_num <> trunc(v_qty_num) then
      raise exception 'invalid_quantity'
        using errcode = 'P0001',
              detail = json_build_object('quantity', v_qty_num)::text;
    end if;
    v_qty := v_qty_num::bigint;

    -- THE LINE MUST ALREADY BE ON THIS ORDER. See the header: an amend
    -- reduces or corrects a promise the customer made; it does not make a new
    -- one on their behalf.
    select oi.unit_price_cents, oi.product_name
      into v_unit, v_name
      from public.order_items oi
     where oi.order_id = p_order_id and oi.product_id = v_pid;
    if not found then
      raise exception 'order_line_not_in_order'
        using errcode = 'P0001',
              detail = json_build_object('product_id', v_pid)::text;
    end if;

    -- Zero is how the sheet says "drop this line". It is not an error, and it
    -- is not the same as omitting it -- both remove the line, and a client
    -- that renders every line with a stepper will send the zero.
    if v_qty = 0 then
      continue;
    end if;

    if v_pricing = 'current' then
      -- The NAME is not re-read with the price. It is the customer's
      -- paperwork -- what they were told they were buying -- and a shop
      -- renaming a product does not change what was ordered. Only the money
      -- moves, which is the whole of what 'current' means.
      select p.price_cents into v_unit
        from public.products p
       where p.id = v_pid and p.shop_id = v_order.shop_id;
      if not found then
        raise exception 'order_product_deleted'
          using errcode = 'P0001',
                detail = json_build_object('products', v_name)::text;
      end if;
    end if;

    if v_unit * v_qty > c_max_line_cents then
      raise exception 'order_line_out_of_range'
        using errcode = 'P0001',
              detail = json_build_object(
                'product_name', v_name,
                'quantity',     v_qty,
                'max_cents',    c_max_line_cents)::text;
    end if;

    v_subtotal := v_subtotal + v_unit * v_qty;
    v_new := v_new || jsonb_build_object(
      'product_id',       v_pid,
      'product_name',     v_name,
      'unit_price_cents', v_unit,
      'quantity',         v_qty,
      'line_total_cents', v_unit * v_qty);
  end loop;

  if jsonb_array_length(v_new) = 0 then
    raise exception 'order_has_no_items' using errcode = 'P0001';
  end if;

  -- ── Fulfilment, and the fee that follows from it ──────────────────────
  v_fulfil   := v_order.fulfilment;
  v_area     := v_order.delivery_area;
  v_landmark := v_order.delivery_landmark;
  v_fee      := v_order.delivery_fee_cents;

  if p_fulfilment is not null then
    v_fulfil := coalesce(p_fulfilment->>'fulfilment', v_order.fulfilment);
    if v_fulfil not in ('collect', 'deliver') then
      raise exception 'invalid_fulfilment'
        using errcode = 'P0001',
              detail = json_build_object('fulfilment', v_fulfil)::text;
    end if;

    if v_fulfil = 'collect' then
      -- Both, together. orders_delivery_matches_fulfilment requires the area
      -- null AND the fee zero for collect, so clearing one without the other
      -- would fail the constraint from inside this function instead of
      -- refusing cleanly.
      v_area     := null;
      v_landmark := null;
      v_fee      := 0;
    else
      if not exists (
        select 1 from public.storefronts s
         where s.shop_id = v_order.shop_id and s.offers_delivery
      ) then
        raise exception 'delivery_unavailable' using errcode = 'P0001';
      end if;

      v_area_in := btrim(coalesce(p_fulfilment->>'delivery_area', v_order.delivery_area, ''));
      if v_area_in = '' then
        raise exception 'unknown_delivery_area' using errcode = 'P0001';
      end if;

      -- THE FEE COMES FROM THE SHOP'S OWN ROW. Never a parameter; see the
      -- header. v_area is set from a.name rather than from what the caller
      -- typed, for the same reason place_storefront_order does it.
      select a.fee_cents, a.name into v_fee, v_area
        from public.storefront_delivery_areas a
       where a.shop_id = v_order.shop_id and a.name = v_area_in;
      if not found then
        raise exception 'unknown_delivery_area'
          using errcode = 'P0001',
                detail = json_build_object('area', v_area_in)::text;
      end if;

      v_landmark := nullif(btrim(coalesce(
        p_fulfilment->>'delivery_landmark', v_order.delivery_landmark, '')), '');
    end if;
  end if;

  -- ── The contact, validated here rather than at the column ─────────────
  v_cname  := v_order.customer_name;
  v_cphone := v_order.customer_phone;
  if p_contact is not null then
    v_cname  := btrim(coalesce(p_contact->>'customer_name', v_order.customer_name));
    v_cphone := btrim(coalesce(p_contact->>'customer_phone', v_order.customer_phone));
    -- The column CHECK would refuse a bad number too, as a raw Postgres
    -- constraint violation with the regex in it. A shopkeeper fixing a typo
    -- gets a code the client can turn into a sentence instead.
    if v_cname = '' or v_cphone !~ '^\+[1-9][0-9]{7,14}$' then
      raise exception 'invalid_contact'
        using errcode = 'P0001',
              detail = json_build_object('customer_phone', v_cphone)::text;
    end if;
  end if;

  if v_subtotal + v_fee > c_max_int_cents then
    raise exception 'order_total_out_of_range'
      using errcode = 'P0001',
            detail = json_build_object(
              'subtotal_cents', v_subtotal,
              'max_cents',      c_max_int_cents)::text;
  end if;

  -- ── The write ─────────────────────────────────────────────────────────
  --
  -- Delete-then-insert rather than a diff: the incoming array IS the order as
  -- it should now stand, so every surviving row is rewritten from it and
  -- anything unnamed is gone. A diff would have to decide what an omitted
  -- line means, and it means the same thing as a zero.
  delete from public.order_items where order_id = p_order_id;
  insert into public.order_items
    (order_id, product_id, product_name, unit_price_cents, quantity, line_total_cents)
  select p_order_id,
         (l->>'product_id')::uuid,
         l->>'product_name',
         (l->>'unit_price_cents')::integer,
         (l->>'quantity')::integer,
         (l->>'line_total_cents')::integer
    from jsonb_array_elements(v_new) l;

  update public.orders set
    customer_name      = v_cname,
    customer_phone     = v_cphone,
    fulfilment         = v_fulfil,
    delivery_area      = v_area,
    delivery_landmark  = v_landmark,
    subtotal_cents     = v_subtotal::integer,
    delivery_fee_cents = v_fee,
    total_cents        = (v_subtotal + v_fee)::integer
  where id = p_order_id
  returning * into v_order;

  v_after := jsonb_build_object(
    'subtotal_cents',     v_order.subtotal_cents,
    'delivery_fee_cents', v_order.delivery_fee_cents,
    'total_cents',        v_order.total_cents,
    'fulfilment',         v_order.fulfilment,
    'delivery_area',      v_order.delivery_area,
    'delivery_landmark',  v_order.delivery_landmark,
    'customer_name',      v_order.customer_name,
    'customer_phone',     v_order.customer_phone,
    'lines', coalesce((
      select jsonb_agg(jsonb_build_object(
               'product_id',       oi.product_id,
               'product_name',     oi.product_name,
               'unit_price_cents', oi.unit_price_cents,
               'quantity',         oi.quantity)
             order by oi.product_name)
        from public.order_items oi where oi.order_id = p_order_id), '[]'::jsonb));

  insert into public.order_amendments
    (order_id, amended_by, reason, customer_note, pricing, before, after)
  values
    (p_order_id, v_actor, v_reason, v_note, v_pricing, v_before, v_after);

  return v_order;
end $$;

-- Postgres grants EXECUTE to PUBLIC on every new function, so the grant below
-- is a no-op dressed as a decision without this revoke first.
revoke execute on function
  public.amend_order(uuid, jsonb, text, text, text, jsonb, jsonb) from public;
-- authenticated ONLY, never anon. A customer does not amend their own order:
-- Part 3's link is read-only apart from an agreement, and a link that has
-- been forwarded, screenshotted or leaked must never be able to alter one.
grant execute on function
  public.amend_order(uuid, jsonb, text, text, text, jsonb, jsonb) to authenticated;
