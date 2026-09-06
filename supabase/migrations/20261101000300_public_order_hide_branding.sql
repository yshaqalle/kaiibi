-- The hide-branding flag, read onto the second anonymous read that carries
-- it -- the same server-resolved module 20261101000200 put on
-- get_public_storefront, now on get_public_order.
--
-- `kaiibi.com/o/<code>` is the link a customer saves and reopens to check on
-- an order: the highest repeat exposure this application has. It renders
-- from its OWN RPC, not from get_public_storefront, so the flag has to ride
-- this payload separately or the order-status page never learns a shop
-- bought the mark off.
--
-- Not a client-side `planKey === 'pro'` check, and not a bespoke column on
-- plans either, for the same reason 20261101000200 gives: plans get retired
-- and hopped to successors (20260824000100), so a key comparison breaks the
-- first time Pro is renamed, and a column that does not follow the hop hands
-- the mark back to every paying shop the moment it does. `shop_has_module`
-- is the resolved answer -- it already walks shop_effective_plan()
-- (trialing/active/grace and retired-plan hops), any per-shop override, and
-- suspension, off `o.shop_id` (this body's own orders alias is `o`, and
-- `orders.shop_id` is a real column, confirmed against \d public.orders on
-- the local database rather than assumed).
--
-- Copied forward VERBATIM from 20261017000000_a_customer_can_read_their_order.sql,
-- the latest prior definition of get_public_order -- explicit column list
-- (there is none; this function returns jsonb), security definer, its own
-- search_path -- with exactly two additions: one jsonb key (hide_branding)
-- and one select expression feeding it (the shop_has_module call). Nothing
-- else in this body is this migration's business.
--
-- confirm_public_order is NOT redefined here: it already returns
-- `public.get_public_order(p_token)` verbatim (20261017000000), so it picks
-- up hide_branding for free the moment this function is replaced.

create or replace function public.get_public_order(p_token text)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'shop_name',          s.name,
    -- THE NUMBER THE "something is wrong" BUTTON DIALS. Without it that
    -- button opens WhatsApp with a prefilled message and NO RECIPIENT, and
    -- the customer has to go and find the shop themselves -- which quietly
    -- undoes the design it exists to serve: the destructive conversation is
    -- supposed to stay in the human channel, and a channel nobody is at the
    -- other end of is not one. get_public_storefront already publishes this
    -- same column (20261010000100:112), so it exposes nothing new.
    'shop_whatsapp',      s.whatsapp_e164,
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
       limit 1),
    -- NEW in this migration. True only when the shop's effective plan grants
    -- the storefront_branding_removal module
    -- (20261101000100_pro_grants_storefront_branding_removal.sql).
    -- Computed here, not read off a client's cached plan key, because this
    -- page is sessionless -- a customer holding a bare link can never call an
    -- authed RPC to ask, so this security definer function is the only place
    -- left to decide it. shop_has_module needs no join: a shop whose plan
    -- cannot be resolved at all still returns the order rather than dropping
    -- it -- this is a receipt for a trade that already happened, and
    -- 20261017000000's own header is explicit that a lapsed or unresolvable
    -- plan must never take that away, and shop_has_module resolves to false
    -- (branding shown) rather than failing the read.
    'hide_branding', public.shop_has_module(o.shop_id, 'storefront_branding_removal'))
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
-- both use, and 20261017000000's own check 9 is what goes red if the revoke
-- is dropped.
revoke execute on function public.get_public_order(text) from public;
grant execute on function public.get_public_order(text) to anon, authenticated;
