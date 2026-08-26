-- Taking an order from a stranger.
--
-- THIS IS THE FIRST UNAUTHENTICATED WRITE IN THE APPLICATION. Everything else
-- that reaches these tables has a session behind it; this has a phone number
-- and a slug. So the whole of it is written from the assumption that the
-- caller is hostile and that every value they send is a lie until this file
-- has recomputed it.
--
-- The three public READ functions (20260924000100_storefront_public_read.sql)
-- established the shape: security definer, an explicit column list, and one
-- WHERE-clause triple -- slug matches, `published_at is not null`,
-- `shop_has_module(..., 'storefront')`. This function enforces the SAME
-- triple, in the same order, for the same reasons, and a future edit that
-- drops one of the three from here has opened a hole the reads do not have.
-- (shop_has_module takes the shop id explicitly and never consults auth.uid(),
-- which is why it works at all for a caller with no session.)
--
-- ── What the client is allowed to decide ────────────────────────────────
--
-- Product ids, quantities, a name, a phone, collect-or-deliver, an area name,
-- a landmark, a note. That is the whole list. IT SENDS NOTHING ABOUT MONEY.
-- Every unit price is read from `products` here, every line total is
-- multiplied here, the delivery fee is looked up in
-- `storefront_delivery_areas` here, and the order total is added up here. A
-- price accepted from a client is a discount anyone can grant themselves, and
-- there is no session to attribute it to afterwards. Money keys in the items
-- payload are not rejected, they are simply never read -- rejecting them would
-- tell an attacker which key name to try next.
--
-- ── Reject, never skip ──────────────────────────────────────────────────
--
-- A line naming a product from another shop, or one without
-- `is_listed_online`, fails THE WHOLE ORDER. Dropping the bad line and taking
-- the rest is the tempting behaviour and the wrong one: the customer sees a
-- confirmation, pays a total they recognise, and collects a bag missing an
-- item nobody told them about. Same for an unknown delivery area -- refused,
-- never quietly priced at zero, because free delivery nobody authorised is a
-- real loss that shows up as a mystery in the shop's takings.
--
-- ── Stock ───────────────────────────────────────────────────────────────
--
-- NOT reserved and NOT decremented. Plan 4 does that on fulfilment. Ordering
-- more than the shop holds is allowed and surfaces to the shopkeeper, who is
-- a human being with a phone and can say no. The alternative -- decrementing
-- here -- lets anyone with a browser empty a shop's shelves in a loop without
-- ever intending to collect anything, and there is no account to ban.
--
-- ── What a rejection is allowed to say ──────────────────────────────────
--
-- A short, fixed code that names something the CUSTOMER can act on, and
-- nothing else. Never a constraint name, never a column, never a shop id, and
-- above all never whether a given slug exists: an unknown slug, a shop that
-- has not published yet, and a shop whose plan no longer includes the module
-- all answer `shop_unavailable`, word for word. Distinguishing them would
-- turn checkout into the subdomain oracle that 20260924000100's header
-- refuses to build on the read side.
--
-- Anything unexpected -- a constraint this file failed to anticipate, a
-- trigger raising its own message -- is caught and replaced with
-- `order_failed`, after the real error goes to the SERVER log (RAISE LOG,
-- which never travels to the client) so an operator can still diagnose it.
-- The list of codes allowed through is `c_client_errors` below; a code added
-- to the body but not to that list degrades to `order_failed`, which is the
-- direction a mistake here should fail in.

-- ── Phone normalisation ─────────────────────────────────────────────────
--
-- A line-by-line port of toE164 in src/lib/phone-e164.ts, and it must stay
-- one: the client normalises for the person typing, this normalises for
-- everything else that can reach the RPC, and two normalisers that disagree
-- means a number the shop cannot call. The reasoning for each branch lives in
-- that file and is not duplicated here -- only the note that a leading `+` or
-- `00` is a CLAIM about a country code, and a claim that still leaves a
-- leading zero is false and unrepairable.
--
-- Not granted to anyone. It is called only from place_storefront_order, which
-- runs as this function's owner and so needs no grant of its own.
create or replace function public.to_e164(p_input text)
returns text
language plpgsql
immutable
set search_path = public
as $$
declare
  c_default_country constant text := '252';
  v_trimmed text;
  v_digits  text;
  v_after   text;
  v_claims_international boolean;
begin
  if p_input is null then
    return null;
  end if;

  v_trimmed := btrim(p_input);
  v_digits  := regexp_replace(v_trimmed, '[^0-9]', '', 'g');
  if v_digits = '' then
    return null;
  end if;

  v_claims_international := left(v_trimmed, 1) = '+' or left(v_digits, 2) = '00';
  if left(v_digits, 2) = '00' then
    v_digits := substr(v_digits, 3);
  end if;

  if v_claims_international then
    if left(v_digits, 1) = '0' then
      return null;
    end if;
  else
    if left(v_digits, 1) = '0' then
      v_digits := substr(v_digits, 2);
    end if;

    if left(v_digits, length(c_default_country)) = c_default_country then
      v_after := substr(v_digits, length(c_default_country) + 1);
    else
      v_after := null;
    end if;

    if v_after is null then
      if length(v_digits) > 9 then
        return null;
      end if;
      v_digits := c_default_country || v_digits;
    elsif length(v_after) < 7 then
      v_digits := c_default_country || v_digits;
    end if;
  end if;

  if length(v_digits) < 8 or length(v_digits) > 15 then
    return null;
  end if;

  return '+' || v_digits;
end;
$$;

-- ── The rate limit ──────────────────────────────────────────────────────
--
-- There is no rate limiting anywhere else in this repo, so this is a decision
-- rather than a convention to follow. Written down in full because the next
-- person will need to change the number.
--
-- WHAT IS BEING PROTECTED: the shopkeeper's order list. The damage from an
-- unauthenticated write is not database load, it is a real person opening
-- their phone to four hundred fake orders and being unable to find the two
-- real ones. So the bound is per SHOP, per rolling window -- the shop is the
-- asset, and it is the only party in this transaction who is not
-- attacker-controlled. A per-phone bound is worthless (the attacker types the
-- phone) and a per-IP bound belongs at the edge, is trivially rotated, and
-- would still let one attacker bury one shop.
--
-- MECHANISM: a count over `orders.created_at` for that shop, inside this
-- function. Considered and rejected: a counter table keyed by shop and time
-- bucket (needs its own grants, its own gate, and an eviction story, to
-- replace one index scan); pg_cron or an extension (new infrastructure for a
-- feature with no users yet); an edge/gateway limit (not something this repo
-- owns, and it cannot see which shop is being targeted). Counting the rows
-- that already exist adds no state at all, and it counts what actually
-- matters -- orders that landed -- rather than requests this function happened
-- to serve. `orders` is storefront-only (the POS writes `sales`), so every row
-- it counts really did come through this door or the shop's own hands.
--
-- CONCURRENT BURSTS, because the count is of COMMITTED rows: N checkouts
-- running concurrently would each read the same count and could each pass it,
-- bounding a sustained flood but not a simultaneous burst of N -- UNLESS the
-- gap is closed by taking a row lock on this shop's own counter BEFORE the
-- count is read, which the body below does.
--
-- That is not a new critical section. `assign_order_number`
-- (20260926000050_orders.sql) already does
-- `insert into order_number_counters ... on conflict (shop_id) do update
-- ... returning` on every insert into `orders`, which takes a row-exclusive
-- lock on that shop's counter row and holds it to commit -- so a second
-- same-shop checkout already blocks there, milliseconds after this function
-- would otherwise have read the rate-limit count. Locking the same row a few
-- lines earlier, before the count, only moves the start of a queue that was
-- always going to form; it adds no contention beyond what every same-shop
-- checkout already pays at insert time. Two different shops touch two
-- different rows and never wait on each other.
--
-- One case that lock does not cover on its own: a shop's very first order
-- ever has no counter row yet, and `for update` against a WHERE clause that
-- matches no row locks nothing. So the row is upserted (`on conflict (shop_id)
-- do nothing`) immediately before the lock is taken, guaranteeing something
-- exists to lock even on a shop's first checkout. That insert is a no-op
-- after the first order (assign_order_number's own upsert then finds the row
-- already there) and rolls back with everything else in this function if the
-- request is later refused.
--
-- THE NUMBER: 30 orders per shop per hour. One every two minutes, sustained,
-- from a single small shop's public page -- comfortably above what these shops
-- do and far below "the list is unusable". A shop that genuinely outgrows it
-- should get a plan limit (public.shop_limit) rather than a bigger constant,
-- because at that point the ceiling is a commercial fact and not a guess.
--
-- The count is served by this index rather than by orders_shop_id_idx, which
-- would scan a shop's whole history to find the last hour of it. That index is
-- left in place; removing it is a change to Task 1's migration and not this
-- one's business.
create index if not exists orders_shop_created_idx
  on public.orders (shop_id, created_at desc);

create or replace function public.place_storefront_order(
  p_slug     text,
  p_customer jsonb,
  p_items    jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  -- See the header. Every one of these names something the customer can act
  -- on; anything else that escapes the body becomes 'order_failed'.
  c_client_errors constant text[] := array[
    'shop_unavailable', 'rate_limited', 'name_required', 'invalid_name',
    'invalid_phone', 'invalid_fulfilment', 'invalid_landmark', 'invalid_note',
    'delivery_unavailable', 'unknown_delivery_area', 'empty_cart',
    'cart_too_large', 'invalid_quantity', 'unavailable_item'
  ];
  c_rate_limit  constant integer  := 30;
  c_rate_window constant interval := interval '1 hour';
  -- Ceilings, not business rules: an unauthenticated caller must not be able
  -- to decide how much work or storage one request costs.
  c_max_lines    constant integer := 50;
  c_max_quantity constant integer := 999;
  c_max_total    constant bigint  := 1000000000;
  c_max_name     constant integer := 120;
  c_max_landmark constant integer := 300;
  c_max_note     constant integer := 1000;

  v_shop_id         uuid;
  v_offers_delivery boolean;
  v_recent          integer;

  v_name       text;
  v_phone      text;
  v_fulfilment text;
  v_area_in    text;
  v_area       text;
  v_landmark   text;
  v_note       text;

  v_fee      integer := 0;
  v_subtotal bigint  := 0;
  v_total    bigint;

  v_item       jsonb;
  v_lines      jsonb := '[]'::jsonb;
  v_product_id uuid;
  v_quantity   integer;
  v_product_name text;
  v_unit_price integer;
  v_line_total bigint;

  v_order_id     uuid;
  v_number       integer;
  v_payment_mode text;
  v_status       text;
begin
  -- ── 1. The shop, and the same triple the public reads enforce ──────────
  -- Explicit column list, and one query: an unknown slug, a draft storefront
  -- and a de-entitled shop all fall out of it as "no row", which is precisely
  -- why they are indistinguishable in the answer.
  select s.id, f.offers_delivery
    into v_shop_id, v_offers_delivery
  from public.shops s
  join public.storefronts f on f.shop_id = s.id
  where s.slug = lower(p_slug)
    and f.published_at is not null
    and public.shop_has_module(s.id, 'storefront');

  if not found then
    raise exception 'shop_unavailable' using errcode = 'P0001';
  end if;

  -- ── 2. Rate limit, before any real work ───────────────────────────────
  -- Lock this shop's counter row FIRST, before the count is read -- see the
  -- comment above this function for why that closes the concurrent-burst gap
  -- for free. The upsert guarantees a row exists to lock even on a shop's
  -- very first order, when assign_order_number has not created one yet.
  insert into public.order_number_counters (shop_id) values (v_shop_id)
    on conflict (shop_id) do nothing;

  perform 1 from public.order_number_counters
  where shop_id = v_shop_id
  for update;

  select count(*) into v_recent
  from public.orders o
  where o.shop_id = v_shop_id
    and o.created_at > now() - c_rate_window;

  if v_recent >= c_rate_limit then
    raise exception 'rate_limited' using errcode = 'P0001';
  end if;

  -- ── 3. The customer ───────────────────────────────────────────────────
  v_name := btrim(coalesce(p_customer->>'name', ''));
  if v_name = '' then
    raise exception 'name_required' using errcode = 'P0001';
  end if;
  if length(v_name) > c_max_name then
    raise exception 'invalid_name' using errcode = 'P0001';
  end if;

  -- Normalised here and checked against the SAME pattern the orders CHECK
  -- uses, so a number this function accepts can never reach the table and be
  -- refused there -- which would surface as 'order_failed' and tell the
  -- customer nothing about the one field they could have fixed.
  v_phone := public.to_e164(p_customer->>'phone');
  if v_phone is null or v_phone !~ '^\+[1-9][0-9]{7,14}$' then
    raise exception 'invalid_phone' using errcode = 'P0001';
  end if;

  v_fulfilment := p_customer->>'fulfilment';
  if v_fulfilment is null or v_fulfilment not in ('collect', 'deliver') then
    raise exception 'invalid_fulfilment' using errcode = 'P0001';
  end if;

  v_landmark := nullif(btrim(coalesce(p_customer->>'delivery_landmark', '')), '');
  if length(v_landmark) > c_max_landmark then
    raise exception 'invalid_landmark' using errcode = 'P0001';
  end if;

  v_note := nullif(btrim(coalesce(p_customer->>'note', '')), '');
  if length(v_note) > c_max_note then
    raise exception 'invalid_note' using errcode = 'P0001';
  end if;

  -- ── 4. Delivery, priced from the shop's own row at order time ─────────
  if v_fulfilment = 'deliver' then
    -- A shop with delivery switched off publishes no areas
    -- (get_public_delivery_areas requires offers_delivery), so an order that
    -- asks for one is answering a page that no longer exists.
    if not v_offers_delivery then
      raise exception 'delivery_unavailable' using errcode = 'P0001';
    end if;

    v_area_in := p_customer->>'delivery_area';
    if v_area_in is null or btrim(v_area_in) = '' then
      raise exception 'unknown_delivery_area' using errcode = 'P0001';
    end if;

    -- Matched exactly as sent, because the client sends back a name this shop
    -- published; there is no coalesce to a default fee and no fallback branch
    -- on this path, deliberately. `not found` is the only other outcome.
    --
    -- v_area is set from a.name, not v_area_in: this row is the shop's own
    -- record of the area, and every other recomputed value in this function
    -- comes from the row it was looked up in, not from what the client typed
    -- to find it. Byte-equal to v_area_in today because the match above is
    -- exact, but that stops being true the day the lookup is loosened to a
    -- case-insensitive match, and this is the one place that would then have
    -- stored the client's casing instead of the shop's.
    select a.fee_cents, a.name into v_fee, v_area
    from public.storefront_delivery_areas a
    where a.shop_id = v_shop_id and a.name = v_area_in;

    if not found then
      raise exception 'unknown_delivery_area' using errcode = 'P0001';
    end if;
  else
    -- A collect order carries neither, whatever the client sent. The server
    -- decides this, so orders_delivery_matches_fulfilment can never be the
    -- thing that stops a checkout.
    v_area     := null;
    v_landmark := null;
    v_fee      := 0;
  end if;

  -- ── 5. The cart, priced from products ─────────────────────────────────
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'empty_cart' using errcode = 'P0001';
  end if;
  if jsonb_array_length(p_items) > c_max_lines then
    raise exception 'cart_too_large' using errcode = 'P0001';
  end if;

  for v_item in select value from jsonb_array_elements(p_items) loop
    -- A malformed id is answered exactly as a real id for somebody else's
    -- product is: the customer can tell nothing apart from "not for sale
    -- here", which is the whole point.
    begin
      v_product_id := (v_item->>'product_id')::uuid;
    exception when invalid_text_representation then
      raise exception 'unavailable_item' using errcode = 'P0001';
    end;
    if v_product_id is null then
      raise exception 'unavailable_item' using errcode = 'P0001';
    end if;

    begin
      v_quantity := (v_item->>'quantity')::integer;
    exception when invalid_text_representation or numeric_value_out_of_range then
      raise exception 'invalid_quantity' using errcode = 'P0001';
    end;
    if v_quantity is null or v_quantity < 1 or v_quantity > c_max_quantity then
      raise exception 'invalid_quantity' using errcode = 'P0001';
    end if;

    -- The product read, restricted to one row: this shop's product, listed
    -- online. Another shop's product and an unlisted one both miss, and both
    -- take down the whole order rather than being dropped from it. Note there
    -- is no branch here that continues the loop.
    select p.name, p.price_cents
      into v_product_name, v_unit_price
    from public.products p
    where p.id = v_product_id
      and p.shop_id = v_shop_id
      and p.is_listed_online;

    if not found or v_unit_price < 0 then
      raise exception 'unavailable_item' using errcode = 'P0001';
    end if;

    v_line_total := v_unit_price::bigint * v_quantity;
    v_subtotal   := v_subtotal + v_line_total;

    v_lines := v_lines || jsonb_build_object(
      'product_id',       v_product_id,
      'name',             v_product_name,
      'unit_price_cents', v_unit_price,
      'quantity',         v_quantity,
      'line_total_cents', v_line_total
    );
  end loop;

  v_total := v_subtotal + v_fee;
  -- Accumulated in bigint so the ceiling is a decision rather than an integer
  -- overflow, which would arrive as 'order_failed' and mean nothing.
  if v_total > c_max_total then
    raise exception 'cart_too_large' using errcode = 'P0001';
  end if;

  -- ── 6. Write it ───────────────────────────────────────────────────────
  -- `number`, `payment_mode` and `status` are absent on purpose: the first two
  -- belong to 20260926000050's BEFORE INSERT triggers and the third to its
  -- default. RETURNING reads them back after those triggers have run.
  insert into public.orders (
    shop_id, customer_name, customer_phone, fulfilment,
    delivery_area, delivery_landmark, note,
    subtotal_cents, delivery_fee_cents, total_cents
  )
  values (
    v_shop_id, v_name, v_phone, v_fulfilment,
    v_area, v_landmark, v_note,
    v_subtotal::integer, v_fee, v_total::integer
  )
  returning id, number, payment_mode, status
    into v_order_id, v_number, v_payment_mode, v_status;

  insert into public.order_items (
    order_id, product_id, product_name, unit_price_cents, quantity, line_total_cents
  )
  select
    v_order_id,
    (l->>'product_id')::uuid,
    l->>'name',
    (l->>'unit_price_cents')::integer,
    (l->>'quantity')::integer,
    (l->>'line_total_cents')::integer
  from jsonb_array_elements(v_lines) as l;

  -- The authoritative figures, for a client that must display what the server
  -- says rather than what it computed itself. No order id: the caller has no
  -- privilege that would let them do anything with one.
  return jsonb_build_object(
    'number',             v_number,
    'status',             v_status,
    'payment_mode',       v_payment_mode,
    'fulfilment',         v_fulfilment,
    'delivery_area',      v_area,
    'customer_phone',     v_phone,
    'subtotal_cents',     v_subtotal,
    'delivery_fee_cents', v_fee,
    'total_cents',        v_total,
    'items',              v_lines
  );

exception
  when others then
    if sqlerrm = any (c_client_errors) then
      raise;
    end if;
    -- RAISE LOG goes to the server log and never to the client, so the
    -- operator keeps the real error and the customer gets a fixed phrase.
    raise log 'place_storefront_order failed for slug %: % (%)', p_slug, sqlerrm, sqlstate;
    raise exception 'order_failed' using errcode = 'P0001';
end;
$$;

-- ── Grants ──────────────────────────────────────────────────────────────
-- Postgres grants EXECUTE to PUBLIC on every new function, and on a security
-- definer function that means anon can call it whether or not anyone granted
-- it. So `grant execute ... to anon` on its own is a no-op dressed as a
-- decision, and revoking from anon later would not take the access away. The
-- revoke goes FIRST, and the grants below are then the entire list of who can
-- call this -- the same order 20260924000100_storefront_public_read.sql:103
-- uses, and the check in verify-orders.sql that goes red when EXECUTE is
-- revoked from anon is what proves it.
--
-- to_e164 is granted to nobody: place_storefront_order runs as this file's
-- owner and calls it as the owner, so no role needs reach of its own.
revoke execute on function public.to_e164(text) from public;
revoke execute on function public.place_storefront_order(text, jsonb, jsonb) from public;

grant execute on function public.place_storefront_order(text, jsonb, jsonb) to anon, authenticated;

-- No table grant is added here, to anon or to anyone. This function is the
-- whole anonymous surface: `orders` and `order_items` stay shut to anon
-- (20260926000050_orders.sql's grants name only `authenticated`), so there is
-- no second door to keep in step with this one.
