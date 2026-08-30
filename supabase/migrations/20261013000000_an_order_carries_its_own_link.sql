-- An order carries its own link.
--
-- Part 3. A customer who has ordered has no way to find out what happened
-- next: `orders` is shut to `anon` entirely (20260928000300), the only anon
-- surface is the four storefront reads plus place_storefront_order, and the
-- confirmation screen is a dead end the moment it is closed. So the shop
-- fields "where is my order?" on WhatsApp, by hand, one message at a time --
-- and once Part 2 let them AMEND an order, they also had no way to tell the
-- customer what changed except to type it out.
--
-- This mints a capability token on every new order and returns it.
--
--
-- ## Why a token, and not the order id or the order number
--
-- place_storefront_order's own header explains why it returns no order id:
-- "the caller has no privilege that would let them do anything with one."
-- That reasoning is EXTENDED here, not reversed. A bare id is an identifier
-- with no authority attached, which is why handing one out was pointless. A
-- token is the inverse: it carries its own authority, and it is the only
-- thing get_public_order will accept.
--
-- The order NUMBER is emphatically not usable for this. It is sequential per
-- shop and starts at 1 (20260926000050's counter), so "order 7 at this shop"
-- is guessable by anyone who can count -- a customer who received a real link
-- could walk their neighbours' orders by changing one digit.
--
--
-- ## Why the alphabet has no i, l, o or u
--
-- Crockford's base32. This token is read aloud over a phone ("it's a-1-b-2...")
-- and typed by hand off a WhatsApp message, and those four characters are the
-- ones misheard or mistyped as 1, 1, 0 and v. Lower case only, so nobody has
-- to say "capital B".
--
-- That rules out the two obvious alternatives: `encode(..., 'hex')` is 32
-- characters of gibberish with no error resistance, and base64 is mixed case
-- with `+` and `/` needing URL escaping.
--
-- ## Why `% 32` is not the bias bug it looks like
--
-- Reducing a random byte modulo an alphabet size is the classic way to leak
-- a skew: with 26 symbols, values 0..25 would come up more often than 26..31.
-- It is safe HERE and only here because 256 = 8 x 32 exactly, so every symbol
-- is drawn with probability 8/256. **An alphabet whose length does not divide
-- 256 would need rejection sampling.** Stated because the next person to edit
-- that string will not otherwise know it is load-bearing.
--
-- 26 characters x 5 bits = 130 bits, which is the entropy that matters --
-- guessing one is not a thing that happens.
--
--
-- ## Why 90 days
--
-- Long enough to cover the whole life of an order a customer might come back
-- to -- checking what they paid, or what they were owed, weeks after the fact
-- -- and short enough that a token in a forwarded chat, a screenshot or an
-- exported WhatsApp backup stops working within a season. It is not a
-- security boundary on its own (the token is unguessable), it is a limit on
-- how long a LEAKED one stays useful.
--
-- Stored per order rather than computed from created_at at read time, so
-- extending it later for one order is an update and not a special case in
-- every reader.
--
--
-- ## Why the signature does not change
--
-- place_storefront_order ALREADY `returns jsonb` (20260927000000:210), so the
-- link is one more key in a payload the confirmation screen already renders.
-- No drop-and-recreate, so no grant churn, and no window in which the function
-- does not exist. The function is otherwise reproduced WHOLE per this repo's
-- convention, produced by textual substitution against 20260927000000 -- its
-- only definition, verified by
-- `grep -n "function public.place_storefront_order" supabase/migrations/*.sql`
-- -- rather than retyped. The four changes are: two locals, the retry loop,
-- two columns on the insert, and one key on the way out.
--
--
-- ## The columns are nullable, deliberately
--
-- Every order placed before this migration has no token, and must not be
-- broken by one. Such an order simply has no link to share; the shop works it
-- exactly as before, and the copy affordance renders nothing rather than
-- `kaiibi.com/o/undefined`.

alter table public.orders
  add column share_token        text unique,
  add column share_expires_at   timestamptz,
  -- A FLAG, NOT A SIXTH STATUS. A new word in the status vocabulary would
  -- mean touching the CHECK, the permitted-moves table in the transition
  -- trigger, ORDERS_NEEDING_ACTION, the tabs and ORDER_STATUS_BADGE -- for
  -- something orthogonal to where the order actually is. An order can be
  -- awaiting the customer's agreement at pending, accepted OR ready.
  add column customer_confirmed_at timestamptz;

-- Partial: the lookup this serves is always `where share_token = $1`, and
-- pre-Part-3 orders have none. The unique constraint above already indexes
-- the column, so this is about keeping the hot path off the rows that can
-- never match rather than about uniqueness.
create index orders_share_token_idx on public.orders (share_token)
  where share_token is not null;

-- ## Why the randomness comes from gen_random_uuid and not gen_random_bytes
--
-- The obvious source is pgcrypto's `gen_random_bytes(26)`. It does not work
-- here, and finding out why cost an application: **pgcrypto is installed in
-- the `extensions` schema on Supabase, not `public`** -- so a function
-- carrying this repo's standard `set search_path = public` cannot see it, and
-- the migration fails with `function gen_random_bytes(integer) does not
-- exist`. No migration in this repo had used it before, so nothing had caught
-- that.
--
-- The two obvious fixes are both worse than this one. Widening to
-- `search_path = public, extensions` loosens the resolution rules for a
-- function reached from a SECURITY DEFINER caller, for one call. Writing
-- `extensions.gen_random_bytes` hard-codes a schema name that is Supabase's
-- convention rather than Postgres's, in a file that would then behave
-- differently on a plain Postgres.
--
-- `gen_random_uuid()` is CORE Postgres (13+, pg_catalog), always resolvable
-- whatever the search_path, and it is already what every table in this schema
-- defaults its primary key to. `uuid_send` turns one into its 16 raw bytes,
-- and two of them give 32 -- more than the 26 needed. So this depends on no
-- extension at all and behaves identically on the local stack, on Supabase,
-- and on any Postgres.
--
-- `order by i` because aggregate order is otherwise unspecified. It does not
-- change the entropy, but a function whose output is not determined by its
-- inputs is a bad thing to leave in a file people will later try to reason
-- about.
create or replace function public.mint_order_share_token() returns text
language sql volatile set search_path = public as $$
  select string_agg(
           substr('0123456789abcdefghjkmnpqrstvwxyz',
                  1 + (get_byte(raw.bytes, i) % 32), 1), '' order by i)
    from (select uuid_send(gen_random_uuid()) || uuid_send(gen_random_uuid()) as bytes) raw,
         generate_series(0, 25) as i;
$$;

-- Nobody at all. place_storefront_order is SECURITY DEFINER and calls this as
-- this file's owner, so no role needs reach of its own -- the same posture
-- to_e164 has (20260927000000's own grants comment). The revoke goes first
-- because Postgres grants EXECUTE to PUBLIC on every new function, which on a
-- function like this would mean anon could mint tokens all day.
revoke execute on function public.mint_order_share_token() from public;

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

  -- Part 3: the customer's own link. See the header for why a token and not
  -- the order id or number.
  v_token   text;
  v_attempt integer;

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
  -- Retried against the unique index rather than trusted first time. At 130
  -- bits a collision is not a thing that happens -- but "does not happen" and
  -- "cannot happen" differ by one loop, and the failure mode without it is a
  -- customer's checkout dying on a unique violation they can do nothing about.
  -- Five attempts then give up as `order_failed`, which is this function's own
  -- word for "something broke and it is not your fault".
  for v_attempt in 1 .. 5 loop
    v_token := public.mint_order_share_token();
    exit when not exists (select 1 from public.orders o where o.share_token = v_token);
    v_token := null;
  end loop;
  if v_token is null then
    raise exception 'order_failed' using errcode = 'P0001';
  end if;

  insert into public.orders (
    shop_id, customer_name, customer_phone, fulfilment,
    delivery_area, delivery_landmark, note,
    subtotal_cents, delivery_fee_cents, total_cents,
    share_token, share_expires_at
  )
  values (
    v_shop_id, v_name, v_phone, v_fulfilment,
    v_area, v_landmark, v_note,
    v_subtotal::integer, v_fee, v_total::integer,
    v_token, now() + interval '90 days'
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
    'items',              v_lines,
    -- THE CUSTOMER LEAVES CHECKOUT HOLDING THE LINK. Returned here rather
    -- than fetched afterwards because the confirmation screen already renders
    -- this payload -- so showing the link costs no second query, no loading
    -- state, and no second place for the address to be built.
    'share_token',        v_token
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

-- Unchanged from 20260927000000, and restated because the function was
-- re-created above: a `create or replace` keeps existing grants, but stating
-- them keeps this file readable on its own rather than by cross-reference.
revoke execute on function public.place_storefront_order(text, jsonb, jsonb) from public;
grant execute on function public.place_storefront_order(text, jsonb, jsonb) to anon, authenticated;
