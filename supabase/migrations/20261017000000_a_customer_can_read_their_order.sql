-- A customer can read their own order.
--
-- Part 3. Until now the only thing a customer got was a confirmation screen
-- that died the moment they closed it: `orders` is shut to `anon` outright
-- (20260928000300), the anonymous surface is four storefront functions, and
-- so "where is my order?" arrives on the shop's WhatsApp, by hand, one
-- message at a time. Part 2 made that worse before it made it better -- a
-- shop can now AMEND an order, and had no way to tell the customer what
-- changed except to type it out.
--
-- This is `get_public_order`, keyed on the capability token 20261016000000
-- mints.
--
--
-- ## A FIFTH function on a surface that was deliberately narrowed to four
--
-- 20261009000100_narrow_the_anon_rpc_surface.sql went through every function
-- in `public` and revoked EXECUTE from PUBLIC, leaving exactly four callable
-- by `anon`: get_public_storefront, get_public_storefront_products,
-- get_public_delivery_areas, place_storefront_order. Adding to that list is
-- not a routine act and this header is the argument for it.
--
-- It belongs to the same family -- the public storefront -- and it is a READ
-- keyed on a capability the shop itself chose to hand out. The token is
-- unguessable (130 bits), scoped to exactly one order, and expires. Nothing
-- about the caller is trusted: there is no p_shop_id, no p_order_id, no
-- p_include_internal. THE TOKEN IS THE ONLY INPUT, and that is deliberate --
-- this function is granted to anon, so every parameter it declares is a
-- field any stranger on the internet can send, and 20261011000000's header
-- records what one extra parameter cost the last time.
--
--
-- ## NO MODULE GATE, and that is deliberate
--
-- All four existing anon RPCs refuse a shop whose plan no longer includes
-- the storefront: get_public_storefront returns nothing, and
-- place_storefront_order answers `shop_unavailable`. THIS ONE DOES NOT, and
-- the divergence is a decision rather than an oversight -- which is worth
-- saying plainly, because a reader comparing the five otherwise sees four
-- with a gate and one without.
--
-- The other four are the SHOP'S marketing surface: browsing a catalogue and
-- placing a new order are things a lapsed shop should stop doing. This is a
-- receipt for a trade that ALREADY HAPPENED. The customer is owed goods, or
-- news that they are not coming, and a shop downgrading its plan is not a
-- reason to take that away from them -- it punishes the wrong person, and
-- the shop keeps its own record of the order either way.
--
-- Nothing is exposed by it. The payload is the same narrow projection, still
-- keyed on a token the shop chose to hand out, still expiring.
-- verify-public-order pins the behaviour so a future edit that "fixes the
-- inconsistency" has to come past a check that says why.

-- ## What it returns, and what it must never return
--
-- RETURNS: the shop's name, the order number, status, when it was placed,
-- the lines (name, quantity, line total), the three money figures,
-- fulfilment, where to go, whether the customer has already agreed, and --
-- when the order has been amended -- the customer-facing note and a
-- before/after diff.
--
-- NEVER RETURNS: cost prices. Stock levels. Shortfall counts -- "only 3
-- left" is competitive information about the shop, not news about the order.
-- The internal amendment `reason`. `cancellation_reason`. Any internal id.
-- The sale id. The customer's own phone number is also left out: it adds
-- nothing they do not know and it is the one field that would turn a
-- forwarded link into a contact-details leak.
--
-- `before`/`after` are RE-PROJECTED down to three keys rather than passed
-- through. order_amendments.before carries product_id and unit_price_cents,
-- and forwarding the blob whole would put a uuid on the customer's screen --
-- which check 5 refuses by SHAPE, so an id nobody thought to name is caught
-- too.
--
--
-- ## An unknown token and an expired one answer identically
--
-- Both return SQL null. Not "expired" versus "not found": a different answer
-- for the two makes this an oracle that tells a stranger which tokens are
-- real, which is the same reason place_storefront_order refuses an
-- unpublished shop and an unknown slug with one message (20260924000100's
-- header). Check 7 compares the two answers to EACH OTHER rather than
-- checking both are empty, so a future edit that distinguishes them fails.
--
--
-- ## Where to go, and why it is two different things
--
-- A DELIVER order carries the landmark the customer themselves gave at
-- checkout -- that is where the goods are going. A COLLECT order carries the
-- SHOP's own address, resolved exactly as get_public_storefront resolves it
-- (20261010000100:224, `is_primary desc, created_at asc` through a left join
-- lateral, so a shop with no locations still answers with null rather than
-- dropping out).
--
-- Sending a delivery customer to the shop counter, or a collection customer
-- to their own house, are both worse than saying nothing -- and a rail that
-- says "Ready" without saying where to go is the exact failure the current
-- confirmation screen has.

create or replace function public.get_public_order(p_token text)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'shop_name',          s.name,
    'number',             o.number,
    'status',             o.status,
    'placed_at',          o.created_at,
    'fulfilment',         o.fulfilment,
    -- See the header: the customer's landmark on a delivery, the shop's own
    -- address on a collection.
    'where_to_go',        case when o.fulfilment = 'deliver' then o.delivery_landmark else pick.address end,
    'lines', coalesce((
      select jsonb_agg(jsonb_build_object(
               'product_name',     oi.product_name,
               'quantity',         oi.quantity,
               'line_total_cents', oi.line_total_cents)
             order by oi.product_name)
        from public.order_items oi where oi.order_id = o.id), '[]'::jsonb),
    'subtotal_cents',     o.subtotal_cents,
    'delivery_fee_cents', o.delivery_fee_cents,
    'total_cents',        o.total_cents,
    'confirmed_at',       o.customer_confirmed_at,
    -- The LATEST amendment only. A customer needs to know what the order is
    -- now and what it was a moment ago, not the shop's whole editing history.
    'amendment', (
      select jsonb_build_object(
               'customer_note', a.customer_note,
               'was_cents',     (a.before->>'subtotal_cents')::bigint,
               'now_cents',     (a.after->>'subtotal_cents')::bigint,
               -- RE-PROJECTED, never passed through: the stored blob carries
               -- product_id and unit_price_cents.
               'before', coalesce((select jsonb_agg(jsonb_build_object(
                            'product_name',     l->>'product_name',
                            'quantity',         (l->>'quantity')::integer,
                            'line_total_cents', (l->>'unit_price_cents')::bigint * (l->>'quantity')::integer))
                          from jsonb_array_elements(a.before->'lines') l), '[]'::jsonb),
               'after', coalesce((select jsonb_agg(jsonb_build_object(
                            'product_name',     l->>'product_name',
                            'quantity',         (l->>'quantity')::integer,
                            'line_total_cents', (l->>'unit_price_cents')::bigint * (l->>'quantity')::integer))
                          from jsonb_array_elements(a.after->'lines') l), '[]'::jsonb))
        from public.order_amendments a
       where a.order_id = o.id
       order by a.amended_at desc, a.id desc
       limit 1))
  from public.orders o
  join public.shops s on s.id = o.shop_id
  -- LEFT join lateral for the same reason 20261010000100 uses one: a shop
  -- with no locations at all still answers, with a null address, rather than
  -- dropping the customer's order off the face of the earth.
  left join lateral (
    select l.address
      from public.shop_locations l
     where l.shop_id = o.shop_id
     order by l.is_primary desc, l.created_at asc
     limit 1
  ) pick on true
  where o.share_token = p_token
    -- btrim'd and non-empty, so a caller sending "" or "   " cannot match a
    -- row whose token was somehow blank.
    and btrim(coalesce(p_token, '')) <> ''
    -- EXPIRY IS PART OF THE MATCH, not a branch after it. A `case when
    -- expired then null` would still have had to decide what to say, and the
    -- temptation would be to say something different. Folding it into the
    -- where clause means an expired token simply does not exist, which is
    -- the same thing an unknown one is.
    and (o.share_expires_at is null or o.share_expires_at > now());
$$;

-- Postgres grants EXECUTE to PUBLIC on every new function, and on a SECURITY
-- DEFINER function that means anon can already call it whether or not anyone
-- said so. The revoke goes FIRST; the grant below is then the entire list of
-- who may call this. Same order 20260924000100:103 and 20260927000000:499
-- both use, and check 9 is what goes red if the revoke is dropped.
revoke execute on function public.get_public_order(text) from public;
grant execute on function public.get_public_order(text) to anon, authenticated;


-- ── confirm_public_order: the first anon WRITE this application has ─────
--
-- ## The asymmetry IS the security argument
--
-- Everything above is a read. This one writes, as `anon`, and it is the
-- first time this application has granted that. The reason it is safe is not
-- that the token is hard to guess -- it is that THERE IS NOTHING HARMFUL
-- THIS FUNCTION CAN DO.
--
-- An order link is sent to one customer over WhatsApp and lives in their
-- chat history forever. It will be forwarded, screenshotted, pasted into a
-- family group, and eventually turn up in an exported backup. So the design
-- question is not "how do we stop the link leaking" -- it will -- but "what
-- is the worst thing someone holding a leaked link can do?"
--
-- The answer is: agree with something the shop itself proposed. That is all.
-- It stamps `customer_confirmed_at` and NOTHING else. It cannot change a
-- line, a quantity, a total, a status, an address, or the token. It cannot
-- cancel. verify-public-order check 13 is that property asserted the only
-- way worth asserting it -- the WHOLE row is captured before and after with
-- the timestamp stripped, and compared entire, so an edit that also touched
-- a column no test names still fails.
--
-- "Something's wrong" is deliberately NOT a code path here. It writes
-- nothing at all: the page opens WhatsApp to the shop. The destructive
-- conversation stays in the human channel, which is where it already lives
-- and where the shop can ask who it is talking to.
--
--
-- ## Idempotent, and why that is not just tidiness
--
-- A customer taps twice. A flaky connection retries. A forwarded link is
-- opened by three relatives. None of that may move the timestamp, because
-- the timestamp is the shop's record of WHEN the customer agreed -- and on
-- an amended order that is the record of when they accepted a changed
-- total. Silently rewriting it would quietly re-date an agreement about
-- money. So the stamp is written only when it is absent, and check 12
-- asserts EQUALITY against the first value rather than merely "still set".
--
--
-- ## A cancelled order cannot be agreed to
--
-- It is still READABLE -- the customer is owed that news -- but there is
-- nothing left to agree with, and a confirmation stamped on a cancelled
-- order would show the shop an "awaiting customer" flag resolving on an
-- order that is over.
--
-- ## Unknown and expired, again identically
--
-- Same as the read, and for the same reason: a different answer for the two
-- tells a stranger which tokens are real. Both simply fail to match.
create or replace function public.confirm_public_order(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id     uuid;
  v_status text;
  v_at     timestamptz;
begin
  -- FOR UPDATE, so two taps from two devices queue instead of both reading a
  -- null stamp and both writing one. The second wakes up, sees the stamp,
  -- and leaves it alone.
  select o.id, o.status, o.customer_confirmed_at
    into v_id, v_status, v_at
    from public.orders o
   where o.share_token = p_token
     and btrim(coalesce(p_token, '')) <> ''
     and (o.share_expires_at is null or o.share_expires_at > now())
   for update;

  -- Unknown, or expired. Indistinguishable, on purpose.
  if v_id is null then
    return null;
  end if;

  -- Readable, but there is nothing left to agree with.
  if v_status = 'cancelled' then
    return public.get_public_order(p_token);
  end if;

  -- ONLY WHEN ABSENT. See the header: this is the shop's record of when the
  -- customer agreed, and a retry must not re-date it.
  if v_at is null then
    update public.orders
       set customer_confirmed_at = now()
     where id = v_id;
  end if;

  -- The same projection the read uses, so this cannot become a second,
  -- looser place where the payload is decided.
  return public.get_public_order(p_token);
end $$;

revoke execute on function public.confirm_public_order(text) from public;
grant execute on function public.confirm_public_order(text) to anon, authenticated;
