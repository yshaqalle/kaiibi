-- The membership gate was bypassed by NOT LOGGING IN. It is not now.
--
-- ## WHAT 20261005000100 GOT WRONG
--
-- It gated post_journal_entry -- `security definer`, RLS-bypassing, and the
-- function every money-moving path in this database funnels through -- on:
--
--   if auth.uid() is not null and not public.is_shop_member(p_shop_id) then
--
-- and defended the `auth.uid() is not null` qualifier at :53-58 with, verbatim:
-- "`anon` HOLDS NO EXECUTE GRANT on this function and never has". BOTH HALVES
-- OF THAT ARE FALSE. 20261005000100:215 grants EXECUTE to `authenticated`, but
-- nothing in this repo ever revoked PostgreSQL's DEFAULT GRANT TO `PUBLIC`, and
-- `anon` is a member of `PUBLIC`. Re-derived here against the live stack rather
-- than taken from the review:
--
--   select coalesce(array_to_string(proacl,','),'<default>') from pg_proc
--    where oid = 'public.post_journal_entry(uuid,date,text,jsonb,uuid,text,boolean)'::regprocedure;
--    =X/postgres,postgres=X/postgres,service_role=X/postgres,authenticated=X/postgres
--    ^ the leading `=` IS PUBLIC
--   has_function_privilege('anon', …, 'EXECUTE') -> t
--   has_schema_privilege('anon', 'public', 'USAGE') -> t
--
-- So a stranger who sends NO Authorization header has `auth.uid()` null, skips
-- the gate on its first conjunct, and posts into any shop by id. Reproduced:
--
--   NOTICE:  current_user=anon  auth.uid()=<null>  is_shop_member=f
--   NOTICE:  anon has EXECUTE on post_journal_entry = t
--   NOTICE:  ANON POSTED source=close: f0ff193c-…
--   NOTICE:  ANON POSTED source=sale:  9845483b-…
--   NOTICE:  rows really in journal_entries for the victim shop: 2
--
-- The attacker's only extra step over the pre-fix state is: DO NOT LOG IN. That
-- is a downgrade, not a fix -- `EXPO_PUBLIC_SUPABASE_ANON_KEY` is inlined into
-- every client bundle, and the population that knows a shop_id but is no longer
-- a member is EXACTLY the population `is_shop_member` was added to exclude. A
-- removed member signing out got their access back.
--
-- ## WHY THE REPLACEMENT IS `request.jwt.claims` AND NOT `auth.uid()`
--
-- The distinction the gate wants is "did this call arrive through PostgREST",
-- not "does it carry a user". The exemption exists for `postgres` running a
-- migration, a maintenance script, or a trigger fired by one -- and such a
-- caller can write journal_entries directly, RLS and all, so it is above this
-- boundary rather than outside it. verify-entitlements.sql and
-- verify-inventory-permissions.sql both insert an `expenses` row as superuser
-- and reach here through post_expense_to_ledger; a bare membership test refuses
-- them, which is why the qualifier was reached for in the first place.
--
-- VERIFIED OVER REAL HTTP against the local PostgREST, not assumed -- the last
-- two justifications for this exemption were assumptions and both were wrong. A
-- probe function reporting the GUCs, called four ways:
--
--   no headers at all  -> claims '{"role":"anon"}'          auth.uid() NULL
--   apikey only        -> claims '{"role":"anon"}'          auth.uid() NULL
--   Bearer anon key    -> claims '{…,"role":"anon"}'        auth.uid() NULL
--   Bearer service key -> claims '{…,"role":"service_role"}' auth.uid() NULL
--   (all four: session_user=authenticator, current_user=postgres inside a
--    definer function -- so the CALLER'S ROLE is not observable in here, which
--    is why the claims GUC is the only signal available.)
--
-- A request with NO headers whatsoever still carries the claims setting. A psql
-- or migration connection never does. That is the whole discriminator.
--
-- `coalesce(…, '') <> ''` RATHER THAN `is not null`, and the difference is not
-- cosmetic: `set_config('request.jwt.claims', null, true)` -- which every verify
-- script in this repo uses to stop impersonating -- leaves the GUC as the EMPTY
-- STRING, not null. Checked:
--
--   unset        -> NULL
--   set          -> '{"role":"anon"}'
--   set to null  -> ''          <-- `is not null` is TRUE here
--   set to empty -> ''
--
-- An `is not null` test would therefore treat a script that had finished
-- impersonating as a PostgREST request and refuse its superuser work. Both
-- forms block the attack; only this one is honest about what "no JWT" means.
--
-- ## WHAT THIS CHANGES FOR service_role, SAID OUT LOUD
--
-- A `service_role` request also carries claims, so a service_role caller that is
-- not a member of the shop is NOW REFUSED where before `auth.uid()` being null
-- exempted it. That is deliberate and it breaks nothing today: the three edge
-- functions holding the service key (platform-admin, provision-staff,
-- update-staff) touch shops, roles, plans and subscriptions and never the
-- ledger -- checked by reading every `.rpc(` and `.from(` in them. A future
-- backend that wants to post must either act for a member or connect to the
-- database directly, and it will fail LOUDLY rather than silently forging.
--
-- ## THE SECOND BARRIER: THE GRANT ITSELF
--
-- The predicate alone is one barrier, and the reason this hole exists is that
-- one barrier was believed to be two. So the `PUBLIC` default grant goes as
-- well -- this repo already does exactly that for every definer function in the
-- support-thread and storefront files (20260825000000:36, 20260924000100:103).
-- After it, EXECUTE is held by `postgres`, `authenticated` and `service_role`
-- explicitly and by nobody else; `anon` cannot reach the function at all, so the
-- reproduction above fails at the door rather than at the gate.
--
-- CHECKED BEFORE REVOKING, because a revoke that breaks a real caller is worse
-- than the hole. Every function whose body reaches post_journal_entry is
-- `security definer` owned by `postgres` (complete_sale, edit_sale,
-- refund_sale_items, settle_sale_balance, receive_stock, save_stock_count,
-- record_invoice_payment, post_payroll_run, close_accounting_period,
-- complete_storefront_order, post_expense_to_ledger and the backfill), so they
-- execute as the owner and a caller's own privilege on the inner function is
-- never consulted. The only direct callers are src/lib/ledger.ts as
-- `authenticated`, and the tests as `postgres` -- both explicitly granted. The
-- roles that lose it are `anon`, `authenticator` (which only ever SET ROLEs to
-- one of the three), `dashboard_user`, `pgbouncer`, and the `supabase_*` admin
-- roles, all of which are superusers whose privilege checks are skipped anyway.
--
-- open_period_for gets the same revoke. It is `PUBLIC`-executable, takes no
-- permission of its own, and an anonymous caller could therefore create
-- `accounting_periods` rows in any shop (`anon open_period_for: ALLOWED`). It
-- keeps no predicate of its own here -- post_journal_entry is the only door to
-- it that needs one, and giving it a membership test would refuse the backfill.
--
-- WHAT IS STILL OUTSTANDING: the `PUBLIC` default grant is on essentially every
-- function in this schema (complete_sale is one of the few already narrowed).
-- The others are harmless only because each gates on `has_shop_permission`,
-- which is false for a caller with no user -- harmless by argument rather than
-- by construction. A schema-wide grant audit is real work and it is not smuggled
-- into a tenant-boundary fix.
--
-- Reproduced in full from 20261005000100 per this repo's convention that the
-- newest definition of a function is the whole of it. Changed: the first
-- conjunct of the membership gate, and nothing else.
create or replace function public.post_journal_entry(
  p_shop_id uuid,
  p_entry_date date,
  p_description text,
  p_lines jsonb,
  p_location_id uuid default null,
  p_source text default 'manual',
  -- A deliberate adjusting entry into a month that has closed. See
  -- open_period_for (20261002000100) for the two conditions that must hold
  -- together.
  p_adjusting boolean default false
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_entry uuid;
  v_period uuid;
  v_sum bigint;
  v_count integer;
  v_missing text;
  v_ref text;
  v_seq integer;
  v_year text := to_char(p_entry_date, 'YYYY');
begin
  -- MEMBERSHIP FIRST, FOR EVERY SOURCE. security definer bypasses RLS, so
  -- without this a stranger could write entries into any shop by passing any
  -- source other than 'manual'.
  --
  -- The condition is "arrived through PostgREST", NOT "carries a user":
  -- 20261005000100 used `auth.uid() is not null` and an anonymous request --
  -- one with no Authorization header at all -- has no uid, so it skipped the
  -- gate entirely and posted into any shop. PostgREST sets request.jwt.claims
  -- on every request including that one; a psql, migration or superuser-trigger
  -- caller never does, and that caller can write journal_entries directly
  -- anyway. `coalesce(…, '') <> ''` because set_config(…, null, …) leaves the
  -- empty string rather than null. See the header for both, verified.
  if coalesce(current_setting('request.jwt.claims', true), '') <> ''
     and not public.is_shop_member(p_shop_id) then
    raise exception 'You do not have access to this shop.' using errcode = 'P0001';
  end if;

  -- Manual entries need ledger.post ON TOP. A posting phase's RPC will call
  -- this with p_source <> 'manual' from inside its own security definer
  -- function, where the caller has already been gated on the permission that
  -- door needs -- a cashier completing a sale holds pos.access and must not
  -- need ledger.post.
  if p_source = 'manual' and not has_shop_permission(p_shop_id, 'ledger.post') then
    raise exception 'You do not have permission to post journal entries.'
      using errcode = 'P0001';
  end if;

  if p_description is null or length(trim(p_description)) = 0 then
    raise exception 'A journal entry needs a description.' using errcode = 'P0001';
  end if;

  select count(*), coalesce(sum((l->>'amount_cents')::bigint), 0)
    into v_count, v_sum
    from jsonb_array_elements(p_lines) l;

  if v_count < 2 then
    raise exception 'A journal entry needs at least two lines; this one has %.', v_count
      using errcode = 'P0001';
  end if;

  -- Checked here as well as by the deferred trigger, and both are wanted. This
  -- one produces a message naming the difference, which is what the person
  -- typing the entry needs. The trigger produces the guarantee.
  if v_sum <> 0 then
    raise exception 'This entry does not balance: debits and credits differ by %.', v_sum
      using errcode = 'P0001';
  end if;

  select string_agg(distinct l->>'code', ', ') into v_missing
    from jsonb_array_elements(p_lines) l
   where not exists (
     select 1 from public.accounts a
      where a.shop_id = p_shop_id and a.code = l->>'code' and a.archived_at is null
   );
  if v_missing is not null then
    raise exception 'No such account: %. Check the chart of accounts.', v_missing
      using errcode = 'P0001';
  end if;

  -- Raises if the month is locked, or closed and this is not a deliberate
  -- adjusting entry from somebody holding ledger.close. Opens the month if it
  -- is the first entry of it.
  v_period := public.open_period_for(p_shop_id, p_entry_date, p_adjusting);

  -- Per shop per year, gapless, and serialised. ONE statement: the upsert takes
  -- a row lock on the counter, so a concurrent poster blocks here rather than
  -- reading the same number and losing a unique-violation race at the insert
  -- below. See 20260908000150's header for what that race did to a sale.
  --
  -- `next_number - 1` because the row is left holding the number the NEXT
  -- caller gets: the insert path stores 2 and returns 1, the update path stores
  -- N+1 and returns N.
  insert into public.journal_entry_sequences (shop_id, year, next_number)
    values (p_shop_id, v_year, 2)
    on conflict (shop_id, year) do update set next_number = public.journal_entry_sequences.next_number + 1
    returning next_number - 1 into v_seq;
  v_ref := public.journal_entry_reference(v_year, v_seq);

  insert into public.journal_entries
      (shop_id, period_id, entry_date, reference, description, source, status, location_id, created_by)
    values (p_shop_id, v_period, p_entry_date, v_ref, trim(p_description), p_source, 'posted',
            p_location_id, auth.uid())
    returning id into v_entry;

  insert into public.journal_lines (entry_id, account_id, amount_cents, location_id, memo)
    select v_entry,
           (select a.id from public.accounts a where a.shop_id = p_shop_id and a.code = l->>'code'),
           (l->>'amount_cents')::bigint,
           coalesce((l->>'location_id')::uuid, p_location_id),
           l->>'memo'
      from jsonb_array_elements(p_lines) l;

  return v_entry;
end;
$$;

-- The revoke goes FIRST so that the grants below are the entire list of who can
-- call this, readable in one place -- the convention 20260927000000:501 sets.
revoke execute on function public.post_journal_entry(uuid, date, text, jsonb, uuid, text, boolean) from public;
grant execute on function public.post_journal_entry(uuid, date, text, jsonb, uuid, text, boolean) to authenticated;
grant execute on function public.post_journal_entry(uuid, date, text, jsonb, uuid, text, boolean) to service_role;

revoke execute on function public.open_period_for(uuid, date, boolean) from public;
grant execute on function public.open_period_for(uuid, date, boolean) to authenticated;
grant execute on function public.open_period_for(uuid, date, boolean) to service_role;

comment on function public.post_journal_entry(uuid, date, text, jsonb, uuid, text, boolean) is
  'Posts a balanced journal entry, allocating its JE- reference from journal_entry_sequences and resolving its period through open_period_for(). REQUIRES MEMBERSHIP OF THE SHOP FOR EVERY SOURCE whenever the call arrived through PostgREST -- it is security definer and would otherwise let a stranger write into any shop, INCLUDING A STRANGER WHO SENDS NO AUTHORIZATION HEADER AT ALL, which is what gating on auth.uid() being non-null let through. Exempt only for a caller with no request.jwt.claims: psql, a migration, or a trigger fired by one, all of which can write journal_entries directly anyway. EXECUTE is revoked from PUBLIC as a second barrier, so anon cannot reach it. ledger.post is required ON TOP for ''manual'', so that a cashier completing a sale needs pos.access and not ledger.post. Refuses an entry that does not balance, naming the difference, and an unknown account code, naming it.';
