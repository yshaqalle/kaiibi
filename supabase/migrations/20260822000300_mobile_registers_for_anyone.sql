-- A phone register for whoever is holding the phone -- owners included.
--
-- 20260822000000 required a shop_member_id on every kind='mobile' register,
-- which repeats exactly the mistake 20260822000200 had to undo on sessions: an
-- owner has no shop_members row in this app (adminship is shops.owner_id), so
-- ensure_mobile_register() would have refused them the moment it was reachable
-- from the UI. It was not reachable yet, which is the only reason this was not
-- a second bug report.
--
-- Same shape as the fix on sessions: a second identity column for the case that
-- has no roster row, and a check that at least one of them is present. A mobile
-- register always belongs to a person; some people are named by a membership
-- and some by a user id.

alter table public.registers
  add column if not exists user_id uuid references auth.users(id) on delete set null;

alter table public.registers
  drop constraint if exists registers_mobile_has_member;
alter table public.registers
  add constraint registers_mobile_has_a_person
  check (kind <> 'mobile' or shop_member_id is not null or user_id is not null);

create index if not exists registers_user_idx on public.registers(user_id)
  where user_id is not null;

comment on column public.registers.user_id is
  'Whose phone, when they have no shop_members row -- i.e. the shop owner.
   Null for counters and for staff-owned mobile registers.';

-- ---------------------------------------------------------------------------
-- ensure_mobile_register, reproduced whole
--
-- Now finds or creates by membership OR by user, and names the register from
-- whichever identity the caller actually has.
-- ---------------------------------------------------------------------------

create or replace function public.ensure_mobile_register(
  p_shop_id uuid,
  p_location_id uuid,
  p_shop_member_id uuid default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_member_id uuid := coalesce(p_shop_member_id, public.my_shop_member_id(p_shop_id));
  v_user_id uuid := auth.uid();
  v_name text;
  v_register_id uuid;
begin
  if not public.has_shop_permission(p_shop_id, 'pos.access') then
    raise exception 'not authorized for shop %', p_shop_id;
  end if;
  if not public.can_access_location(p_location_id) then
    raise exception 'not authorized for location %', p_location_id;
  end if;
  -- Neither identity means this person is not staff here and does not own the
  -- shop, so there is nobody to name the register after.
  if v_member_id is null and not public.owns_shop(p_shop_id) then
    raise exception 'no active membership in shop % for this user', p_shop_id;
  end if;

  -- Reused, never recreated: a register rebuilt per session could not answer
  -- "how did this seller do this month", which is the whole reason registers
  -- are durable.
  select id into v_register_id from public.registers
   where shop_id = p_shop_id and location_id = p_location_id and kind = 'mobile'
     and (
       (v_member_id is not null and shop_member_id = v_member_id)
       or (v_member_id is null and user_id = v_user_id)
     )
   limit 1;

  if v_register_id is not null then
    -- Reactivate rather than create a second one: a seller who came back after
    -- a spell away keeps their history instead of starting a parallel register.
    update public.registers set active = true, updated_at = now()
      where id = v_register_id and not active;
    return v_register_id;
  end if;

  if v_member_id is not null then
    select coalesce(nullif(btrim(m.full_name), ''), 'Mobile') into v_name
      from public.shop_members m where m.id = v_member_id;
  else
    select coalesce(nullif(btrim(p.full_name), ''), 'Mobile') into v_name
      from public.profiles p where p.id = v_user_id;
  end if;
  v_name := coalesce(v_name, 'Mobile');

  -- The unique (location_id, name) index is what makes this safe under two
  -- devices at once: the loser of the race takes the on-conflict branch and
  -- reads the winner's row instead of creating a duplicate.
  insert into public.registers (shop_id, location_id, name, kind, shop_member_id, user_id)
    values (p_shop_id, p_location_id, v_name || ' — mobile', 'mobile', v_member_id,
            case when v_member_id is null then v_user_id else null end)
    on conflict (location_id, name) do update set updated_at = now()
    returning id into v_register_id;

  return v_register_id;
end;
$$;

grant execute on function public.ensure_mobile_register(uuid, uuid, uuid) to authenticated;
