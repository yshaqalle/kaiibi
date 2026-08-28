-- A stranger cannot read your plan, your usage, or your billing dates.
--
-- The deferred item from #83, which closed the same hole on
-- `post_journal_entry` and said this out loud rather than hiding it:
--
--     the PUBLIC default grant is on nearly every function in the schema.
--     The rest are safe *by argument* -- the kind of argument that has now
--     failed three times here. A schema-wide grant audit is real, separate
--     work and it should happen.
--
-- MEASURED, NOT ARGUED. Against a local stack at the migration head, with the
-- anon key and then with no Authorization header at all -- the case #83 proved
-- still arrives carrying `request.jwt.claims={"role":"anon"}`:
--
--   POST /rest/v1/rpc/shop_effective_status  {"p_shop_id": <any shop>}
--     -> 200 "trialing"          (no headers at all)
--   POST /rest/v1/rpc/my_shop_entitlements   {"p_shop_id": <any shop>}
--     -> 200 {plan, limits, usage:{staff:1,...}, trial_ends_at, ...}
--   POST /rest/v1/rpc/shop_effective_plan    -> 200 full plan record
--   POST /rest/v1/rpc/shop_has_module        -> 200 true
--   POST /rest/v1/rpc/shop_member_in_shop    -> 200 false  (membership oracle)
--   POST /rest/v1/rpc/recompute_product_stock-> 204        (an UNAUTHENTICATED
--                                                           write)
--
-- 113 of this schema's 144 public functions were executable by `anon`; 69 of
-- those are security definer and non-trigger, so their own checks are the
-- tenant boundary. 13 carried no guard in their body. This migration closes
-- the six that a request can actually reach and profit from. The remaining
-- seven are the deliberate storefront reads -- `get_public_storefront`,
-- `get_public_storefront_products`, `get_public_delivery_areas`,
-- `place_storefront_order` and friends -- which exist to serve a customer who
-- is not logged in and are correct as they are.
--
-- WHAT THE LEAK IS WORTH. Not much on its own and quite a lot in aggregate: a
-- shop id is not a secret (it travels in URLs), and with one you could read
-- any shop's plan, whether it is in trial or past due, when that trial ends,
-- how many staff it has and how many sales it made this month. That is a
-- competitor's research list, and it is the kind of thing that is embarrassing
-- to be asked about rather than dangerous to be hit by.
--
-- `recompute_product_stock` is the odd one: it is a WRITE reachable with no
-- credentials at all. Its blast radius is genuinely small, because all it does
-- is set `products.stock` to the sum of that product's `product_location_stock`
-- rows -- it writes the CORRECT value, so it cannot corrupt anything and an
-- attacker's best outcome is healing drift we would have wanted healed. What
-- it does give away is existence: 204 for a product id that exists against an
-- error for one that does not is an enumeration oracle. It is fixed here
-- because an unauthenticated write path is worth closing on principle, before
-- someone later adds a second statement to it.
--
-- WHY REVOKE AND NOT A PREDICATE, for five of the six. They have no client
-- caller at all -- checked against `src/` -- and every SQL caller is a
-- `security definer` function, which runs as the owner and so is unaffected by
-- a PUBLIC revoke. Verified rather than assumed: no SECURITY INVOKER function
-- and no view references any of them, so nothing evaluates them with the
-- caller's own rights.
--
-- THE ONE EXCEPTION, and the reason this is not a blanket revoke. RLS policies
-- ARE evaluated as the invoking role, so a helper used inside one must stay
-- executable by `authenticated`:
--
--   policy "write shop shifts" on public.shifts
--     with check (... and shop_member_in_shop(shop_member_id, shop_id))
--
-- Revoking that from PUBLIC without granting it back to `authenticated` would
-- stop every scheduler writing a shift -- a self-inflicted outage in the name
-- of security. It is granted back below, which still excludes `anon`, because
-- PUBLIC covers both roles and `authenticated` covers only the one we mean.

-- ---------------------------------------------------------------------------
-- Internal helpers: no client caller, no policy, no invoker-rights caller.
-- ---------------------------------------------------------------------------

revoke execute on function public.shop_effective_plan(uuid) from public;
revoke execute on function public.shop_effective_status(uuid) from public;
revoke execute on function public.shop_has_module(uuid, text) from public;
revoke execute on function public.recompute_product_stock(uuid) from public;

-- ---------------------------------------------------------------------------
-- Used by an RLS policy, so `authenticated` keeps it and only `anon` loses it.
-- ---------------------------------------------------------------------------

revoke execute on function public.shop_member_in_shop(uuid, uuid) from public;
grant execute on function public.shop_member_in_shop(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- The one the app really calls, so it gets a predicate as well as a grant.
-- ---------------------------------------------------------------------------

-- TWO INDEPENDENT BARRIERS, which is the shape #83 settled on: the grant stops
-- a caller with no session, and the predicate stops a signed-in caller reading
-- a shop that is not theirs. Either alone would be enough today and neither
-- alone survives the next mistake -- the grant is one `create or replace` away
-- from being silently restored on a fresh database, and a predicate is one
-- refactor away from being dropped.
--
-- `is_shop_member`, not a permission: every member of a shop may see the plan
-- their own shop is on, and gating this on a billing permission would break the
-- upgrade prompts that any member can be shown.
--
-- Rewritten as plpgsql ONLY to get a `raise`, with the select transcribed
-- verbatim from the shipped definition. A `sql` function cannot raise, and
-- returning null for a non-member is indistinguishable from "this shop has no
-- subscription row" -- a real state the client already handles by showing the
-- free tier -- so a silent null would quietly tell a stranger's client that
-- every shop is free rather than refusing it.
--
-- The transcription is pinned by a db check that calls this as a member and
-- asserts the keys, because a hand-copied body is exactly the kind of change
-- that looks right and returns the wrong join. The first draft of this
-- migration got it wrong three ways -- it invented a `cancel_at_period_end`
-- field, dropped `grace_until`, and joined `plans` on an id instead of
-- selecting from `shop_effective_plan(p_shop_id)` as a record.
create or replace function public.my_shop_entitlements(p_shop_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_shop_member(p_shop_id) then
    raise exception 'not authorized for shop %', p_shop_id;
  end if;

  return (
    select jsonb_build_object(
      'status', public.shop_effective_status(p_shop_id),
      'plan', jsonb_build_object(
        'key', pl.key,
        'name', pl.name,
        'price_cents', pl.price_cents,
        'currency', pl.currency,
        'billing_interval', pl.billing_interval
      ),
      'modules', (
        select coalesce(jsonb_agg(m), '[]'::jsonb) from (
          select unnest(pl.modules) as m
          union
          select o.key from public.shop_entitlement_overrides o
          where o.shop_id = p_shop_id and o.kind = 'module'
            and (o.expires_at is null or o.expires_at > now())
        ) resolved
        where public.shop_effective_status(p_shop_id) <> 'suspended'
      ),
      'limits', (
        select coalesce(jsonb_object_agg(r, public.shop_limit(p_shop_id, r)), '{}'::jsonb)
        from unnest(array['locations','products','staff','customers','vendors','sales_per_month']) r
      ),
      'usage', (
        select coalesce(jsonb_object_agg(c.resource, c.count), '{}'::jsonb)
               || jsonb_build_object('sales_per_month', (
                    select count(*) from public.sales s
                    where s.shop_id = p_shop_id and s.created_at >= date_trunc('month', now())
                  ))
        from public.shop_usage_counters c
        where c.shop_id = p_shop_id
      ),
      'trial_ends_at', s.trial_ends_at,
      'current_period_end', s.current_period_end,
      'grace_until', s.grace_until
    )
    from public.shop_effective_plan(p_shop_id) pl
    left join public.shop_subscriptions s on s.shop_id = p_shop_id
  );
end;
$$;

-- An ACL does NOT survive being dropped and recreated, and `create or replace`
-- above kept the old one -- which is the PUBLIC default this migration exists
-- to remove. #83 learned that the hard way: it needed a third form of test
-- because an ACL survives `create or replace`. So the revoke comes AFTER the
-- redefinition, not before it, or it would be undone by its own migration.
revoke execute on function public.my_shop_entitlements(uuid) from public;
grant execute on function public.my_shop_entitlements(uuid) to authenticated;
