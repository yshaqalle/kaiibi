-- The owner can stand at the till too.
--
-- 20260822000000 made register_sessions.shop_member_id NOT NULL, which quietly
-- locked the shop owner out of the whole feature: this app deliberately gives an
-- owner NO shop_members row -- adminship is shops.owner_id and the owner holds
-- every permission implicitly (0017/0024) -- so my_shop_member_id() returns null
-- for them and open_register_session raised "no active membership in shop X".
--
-- For a one-person shop that is every single attempt.
--
-- The fix is to represent an owner-run session the same way the rest of the
-- schema represents an owner: not as a membership. shop_member_id becomes
-- nullable, and `opened_by` (already there, already an auth.users reference)
-- carries the identity when it is null. Every session still says who ran it;
-- some of them say it as a user rather than as a roster row.
--
-- The alternative -- provisioning a shop_members row for owners on the fly --
-- was rejected: it would add the owner to the team roster, the payroll list and
-- the schedule as a side effect of opening a till, which is a much larger claim
-- than "this person counted the drawer today".

alter table public.register_sessions
  alter column shop_member_id drop not null;

-- Whoever ran it must be identifiable one way or the other. Without this the
-- nullable column would allow an anonymous session, which is the one thing this
-- table exists to prevent.
alter table public.register_sessions
  drop constraint if exists register_sessions_has_a_person;
alter table public.register_sessions
  add constraint register_sessions_has_a_person
  check (shop_member_id is not null or opened_by is not null);

-- ---------------------------------------------------------------------------
-- RLS: an owner reads their own sessions through opened_by
-- ---------------------------------------------------------------------------

-- The existing "read own register sessions" joins shop_members, so it matches
-- nothing for an owner-run session. This is the same escape hatch expressed for
-- the identity an owner actually has.
drop policy if exists "read own opened register sessions" on public.register_sessions;
create policy "read own opened register sessions" on public.register_sessions for select
  using (shop_member_id is null and opened_by = auth.uid());

-- ---------------------------------------------------------------------------
-- open_register_session
--
-- Reproduced whole per the house convention. The only change is that a null
-- member is now legal when the caller owns the shop, instead of an error.
-- ---------------------------------------------------------------------------

create or replace function public.open_register_session(
  p_register_id uuid,
  p_shop_member_id uuid default null,
  p_cash jsonb default '[]'::jsonb,
  p_note text default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_register public.registers%rowtype;
  v_member_id uuid;
  v_my_member_id uuid;
  v_session_id uuid;
  v_entry jsonb;
  v_code text;
  v_rate numeric;
begin
  select * into v_register from public.registers where id = p_register_id for update;
  if v_register.id is null then
    raise exception 'register % not found', p_register_id;
  end if;
  if not public.has_shop_permission(v_register.shop_id, 'pos.access') then
    raise exception 'not authorized for shop %', v_register.shop_id;
  end if;
  if not public.can_access_location(v_register.location_id) then
    raise exception 'not authorized for location %', v_register.location_id;
  end if;
  if not v_register.active then
    raise exception 'register % is not active', v_register.name;
  end if;

  v_my_member_id := public.my_shop_member_id(v_register.shop_id);
  v_member_id := coalesce(p_shop_member_id, v_my_member_id);

  -- Null is legal only for the owner, who has no roster row by design. Anyone
  -- else without a membership genuinely has no business opening a register --
  -- they are not on this shop's staff.
  if v_member_id is null and not public.owns_shop(v_register.shop_id) then
    raise exception 'no active membership in shop % for this user', v_register.shop_id;
  end if;

  if v_member_id is not null then
    if not public.shop_member_in_shop(v_member_id, v_register.shop_id) then
      raise exception 'member % does not belong to shop %', v_member_id, v_register.shop_id;
    end if;
    -- Opening a register FOR SOMEONE ELSE is the act that needs its own gate:
    -- setting a float against another person's name is what makes them
    -- accountable for it. An owner opening for themselves has no member id to
    -- compare, which is why this only applies once one exists.
    if v_member_id is distinct from v_my_member_id
       and not public.has_shop_permission(v_register.shop_id, 'registers.manage') then
      raise exception 'not authorized to open a register for another person';
    end if;
  end if;

  if exists (select 1 from public.register_sessions
              where register_id = p_register_id and closed_at is null) then
    raise exception 'register % already has an open session', v_register.name;
  end if;

  insert into public.register_sessions
    (shop_id, location_id, register_id, shop_member_id, opened_by, opening_note)
    values (v_register.shop_id, v_register.location_id, p_register_id, v_member_id,
            auth.uid(), nullif(btrim(coalesce(p_note, '')), ''))
    returning id into v_session_id;

  for v_entry in select value from jsonb_array_elements(coalesce(p_cash, '[]'::jsonb)) as t(value) loop
    v_code := upper(btrim(coalesce(v_entry->>'currency_code', 'USD')));
    if v_code = '' then
      v_code := 'USD';
    end if;
    v_rate := coalesce(
      nullif(v_entry->>'rate_to_usd', '')::numeric,
      (select c.rate_to_usd from public.shop_currencies c
        where c.shop_id = v_register.shop_id and c.code = v_code),
      1
    );
    if v_rate <= 0 then
      raise exception 'exchange rate for % must be greater than zero', v_code;
    end if;

    insert into public.register_session_cash
      (session_id, currency_code, opening_float_minor, opening_rate_to_usd, opening_denominations)
      values (
        v_session_id,
        v_code,
        greatest(coalesce(nullif(v_entry->>'amount_minor', '')::integer, 0), 0),
        v_rate,
        case when v_entry->'denominations' = 'null'::jsonb then null else v_entry->'denominations' end
      )
      on conflict (session_id, currency_code) do update
        set opening_float_minor = excluded.opening_float_minor,
            opening_rate_to_usd = excluded.opening_rate_to_usd,
            opening_denominations = excluded.opening_denominations;
  end loop;

  return v_session_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- close_register_session
--
-- Reproduced whole. The only change is the "is this your own session?" test,
-- which now recognises an owner-run session by opened_by.
-- ---------------------------------------------------------------------------

create or replace function public.close_register_session(
  p_session_id uuid,
  p_cash jsonb default '[]'::jsonb,
  p_note text default null
) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_session public.register_sessions%rowtype;
  v_entry jsonb;
  v_code text;
  v_rate numeric;
  v_variance_base numeric := 0;
  v_is_mine boolean;
begin
  select * into v_session from public.register_sessions where id = p_session_id for update;
  if v_session.id is null then
    raise exception 'register session % not found', p_session_id;
  end if;
  if v_session.closed_at is not null then
    raise exception 'this register session is already closed';
  end if;
  if not public.has_shop_permission(v_session.shop_id, 'pos.access') then
    raise exception 'not authorized for shop %', v_session.shop_id;
  end if;

  -- Yours if the roster row is yours, or -- for an owner-run session, which has
  -- no roster row -- if you are the one who opened it.
  v_is_mine := case
    when v_session.shop_member_id is not null
      then v_session.shop_member_id = public.my_shop_member_id(v_session.shop_id)
    else v_session.opened_by = auth.uid()
  end;

  if not coalesce(v_is_mine, false)
     and not public.has_shop_permission(v_session.shop_id, 'registers.manage') then
    raise exception 'not authorized to close another person''s register';
  end if;

  for v_entry in select value from jsonb_array_elements(coalesce(p_cash, '[]'::jsonb)) as t(value) loop
    v_code := upper(btrim(coalesce(v_entry->>'currency_code', 'USD')));
    if v_code = '' then
      v_code := 'USD';
    end if;
    v_rate := coalesce(
      nullif(v_entry->>'rate_to_usd', '')::numeric,
      (select c.rate_to_usd from public.shop_currencies c
        where c.shop_id = v_session.shop_id and c.code = v_code),
      1
    );
    if v_rate <= 0 then
      raise exception 'exchange rate for % must be greater than zero', v_code;
    end if;

    insert into public.register_session_cash
      (session_id, currency_code, opening_float_minor, opening_rate_to_usd,
       closing_counted_minor, closing_rate_to_usd, closing_denominations)
      values (
        p_session_id, v_code, 0, v_rate,
        greatest(coalesce(nullif(v_entry->>'amount_minor', '')::integer, 0), 0),
        v_rate,
        case when v_entry->'denominations' = 'null'::jsonb then null else v_entry->'denominations' end
      )
      on conflict (session_id, currency_code) do update
        set closing_counted_minor = excluded.closing_counted_minor,
            closing_rate_to_usd = excluded.closing_rate_to_usd,
            closing_denominations = excluded.closing_denominations;
  end loop;

  update public.register_session_cash c
     set expected_minor = e.expected_minor,
         closing_counted_minor = coalesce(c.closing_counted_minor, 0),
         closing_rate_to_usd = coalesce(c.closing_rate_to_usd, c.opening_rate_to_usd),
         variance_minor = coalesce(c.closing_counted_minor, 0) - e.expected_minor
    from public.register_session_expected(p_session_id) e
   where c.session_id = p_session_id and c.currency_code = e.currency_code;

  -- Per-currency variances first, WITHOUT a rate; only then converted and
  -- summed. See 20260822000000 for why that order is the whole design.
  select coalesce(sum(c.variance_minor / c.closing_rate_to_usd), 0)
    into v_variance_base
    from public.register_session_cash c
   where c.session_id = p_session_id;

  update public.register_sessions
     set closed_at = now(),
         closed_by = auth.uid(),
         variance_base_cents = round(v_variance_base)::integer,
         closing_note = nullif(btrim(coalesce(p_note, '')), '')
   where id = p_session_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- handover_register_session
--
-- Reproduced whole. p_incoming_member_id becomes nullable, meaning "whoever is
-- calling" -- an owner taking a register back from a member has no roster row to
-- name themselves with.
-- ---------------------------------------------------------------------------

create or replace function public.handover_register_session(
  p_session_id uuid,
  p_incoming_member_id uuid default null,
  p_cash jsonb default '[]'::jsonb,
  p_note text default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_register_id uuid;
  v_new_session_id uuid;
  v_open_cash jsonb;
begin
  select register_id into v_register_id from public.register_sessions
   where id = p_session_id and closed_at is null;
  if v_register_id is null then
    raise exception 'no open register session %', p_session_id;
  end if;

  perform public.close_register_session(p_session_id, p_cash, p_note);

  select coalesce(jsonb_agg(jsonb_build_object(
           'currency_code', c.currency_code,
           'amount_minor', c.closing_counted_minor,
           'rate_to_usd', c.closing_rate_to_usd,
           'denominations', c.closing_denominations
         )), '[]'::jsonb)
    into v_open_cash
    from public.register_session_cash c
   where c.session_id = p_session_id;

  v_new_session_id := public.open_register_session(v_register_id, p_incoming_member_id, v_open_cash, null);
  return v_new_session_id;
end;
$$;

grant execute on function public.open_register_session(uuid, uuid, jsonb, text) to authenticated;
grant execute on function public.close_register_session(uuid, jsonb, text) to authenticated;
grant execute on function public.handover_register_session(uuid, uuid, jsonb, text) to authenticated;
