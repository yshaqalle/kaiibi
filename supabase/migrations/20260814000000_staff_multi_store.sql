-- A person can work at more than one store.
--
-- 20260812000000 gave shop_members a single location_id, which covers "cashier
-- at the Hargeisa store" and "works everywhere", but not the case in between:
-- someone who covers two of three stores. That is ordinary in a small chain --
-- a supervisor splitting the week, someone covering a colleague's leave -- and
-- a single column cannot express it.
--
-- ## The semantics, unchanged from before
--
-- NO rows for a member = every store. Rows = only those stores. Keeping "no
-- assignment means everywhere" is what stops this migration locking anyone out:
-- an existing member with no location_id had access to all stores and still
-- does, and one with a location_id keeps exactly the store they had.
--
-- ## What this still does NOT do
--
-- One ROLE per person, shop-wide. "Cashier at A, manager at B" would mean a
-- role_id on this table rather than on shop_members, which changes how every
-- permission check resolves (has_shop_permission would need to know which store
-- it is being asked about). That is a much deeper change than adding stores to
-- a roster, and nothing has asked for it yet.

create table public.shop_member_locations (
  shop_member_id uuid not null references public.shop_members(id) on delete cascade,
  location_id uuid not null references public.shop_locations(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (shop_member_id, location_id)
);
create index shop_member_locations_location_idx on public.shop_member_locations(location_id);

-- on delete cascade on BOTH sides, unlike the RESTRICT that 20260812000000
-- deliberately chose for the old column. The reasoning there was that deleting
-- a store must not silently PROMOTE a restricted member to all-stores access.
-- Here a cascade removes one row from a set: a member assigned to A and B who
-- loses B is left with A, which is a narrowing, not a promotion. The only case
-- that still widens is deleting a member's LAST store, which the roster UI
-- prevents by treating "no stores" as an explicit "every store" choice rather
-- than something you can arrive at by deletion.

alter table public.shop_member_locations enable row level security;

-- Readable by anyone who can see the roster at all -- a scheduler must know who
-- staffs which store. Mirrors the reasoning for list_shop_staff not pay-gating
-- location: this is roster information, not compensation.
create policy "read shop_member_locations" on public.shop_member_locations for select
  using (exists (
    select 1 from public.shop_members m
    where m.id = shop_member_id
      and public.has_any_shop_permission(
        m.shop_id,
        array['staff.manage', 'people.payroll.manage', 'people.timesheet.view', 'people.timeoff.approve', 'people.schedule.manage']
      )
  ));

-- Writing is staff.manage, the same gate as the rest of the roster.
create policy "write shop_member_locations" on public.shop_member_locations for all
  using (exists (select 1 from public.shop_members m where m.id = shop_member_id and public.has_shop_permission(m.shop_id, 'staff.manage')))
  with check (exists (select 1 from public.shop_members m where m.id = shop_member_id and public.has_shop_permission(m.shop_id, 'staff.manage')));

grant select, insert, update, delete on public.shop_member_locations to authenticated;

-- Carry the single assignment across. A member with no location_id contributes
-- no rows, which is the same "every store" it already meant.
insert into public.shop_member_locations (shop_member_id, location_id)
select m.id, m.location_id from public.shop_members m where m.location_id is not null;

-- One representation, not two. The column stays only as long as it takes to
-- copy out of it -- leaving it would be a second writable copy of the same
-- fact, which is the drift this codebase has already had to fix twice
-- (20260811000000 for the address, 20260813000000 for the revenue goal).
alter table public.shop_members drop column location_id;

-- ---------------------------------------------------------------------------
-- Enforcement, rewritten against the set
-- ---------------------------------------------------------------------------

-- security definer for the reason given in 20260806000000 and 20260808000000:
-- shop_members (and now shop_member_locations) are readable only with
-- staff.manage and friends, so an inline `exists` in a policy would evaluate
-- under the caller's RLS, see zero rows, and deny everyone.
create or replace function public.can_access_location(p_location_id uuid)
returns boolean
language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from public.shop_locations l
    where l.id = p_location_id
      and (
        public.owns_shop(l.shop_id)
        or exists (
          select 1 from public.shop_members m
          where m.shop_id = l.shop_id
            and m.user_id = auth.uid()
            and m.active
            and (
              -- No assignments at all = every store.
              not exists (select 1 from public.shop_member_locations ml where ml.shop_member_id = m.id)
              or exists (
                select 1 from public.shop_member_locations ml
                where ml.shop_member_id = m.id and ml.location_id = l.id
              )
            )
        )
      )
  );
$$;

create or replace function public.my_location_ids(p_shop_id uuid)
returns setof uuid
language sql security definer stable set search_path = public as $$
  select l.id from public.shop_locations l
  where l.shop_id = p_shop_id
    and (
      public.owns_shop(p_shop_id)
      or exists (
        select 1 from public.shop_members m
        where m.shop_id = p_shop_id
          and m.user_id = auth.uid()
          and m.active
          and (
            not exists (select 1 from public.shop_member_locations ml where ml.shop_member_id = m.id)
            or exists (
              select 1 from public.shop_member_locations ml
              where ml.shop_member_id = m.id and ml.location_id = l.id
            )
          )
      )
    );
$$;

-- ---------------------------------------------------------------------------
-- Roster listing
-- ---------------------------------------------------------------------------

-- Returns the assignment as an ARRAY of ids rather than the single id/name pair
-- 20260812000000 added. An empty array means every store, matching the table's
-- semantics exactly -- the client must not have to distinguish "unassigned"
-- from "assigned to nothing", because those are the same thing.
--
-- Names are not returned: the client already holds the store list and can join
-- by id, and duplicating names here is how they drift after a rename.
drop function if exists public.list_shop_staff(uuid);

create function public.list_shop_staff(p_shop_id uuid)
returns table (
  id uuid,
  shop_id uuid,
  user_id uuid,
  role_id uuid,
  role_name text,
  location_ids uuid[],
  active boolean,
  full_name text,
  email text,
  created_at timestamptz,
  hire_date date,
  pay_type text,
  pay_rate_cents integer,
  pay_cadence text
)
language plpgsql security definer stable set search_path = public as $$
declare
  v_can_see_pay boolean;
begin
  if not public.has_any_shop_permission(
    p_shop_id,
    array['staff.manage', 'people.payroll.manage', 'people.timesheet.view', 'people.timeoff.approve', 'people.schedule.manage']
  ) then
    raise exception 'not authorized for shop %', p_shop_id;
  end if;

  v_can_see_pay := public.has_shop_permission(p_shop_id, 'people.payroll.manage');

  return query
    select
      m.id,
      m.shop_id,
      m.user_id,
      m.role_id,
      coalesce(r.name, '') as role_name,
      coalesce(
        (select array_agg(ml.location_id) from public.shop_member_locations ml where ml.shop_member_id = m.id),
        '{}'::uuid[]
      ) as location_ids,
      m.active,
      m.full_name,
      m.email,
      m.created_at,
      m.hire_date,
      case when v_can_see_pay then m.pay_type else null end as pay_type,
      case when v_can_see_pay then m.pay_rate_cents else null end as pay_rate_cents,
      case when v_can_see_pay then m.pay_cadence else null end as pay_cadence
    from public.shop_members m
      left join public.roles r on r.id = m.role_id
    where m.shop_id = p_shop_id
    order by m.created_at;
end;
$$;

grant execute on function public.list_shop_staff(uuid) to authenticated;

-- Replaces a member's whole assignment set in one transaction. A delete
-- followed by an insert from the client would leave the member briefly
-- unassigned -- which under these semantics means "every store", i.e. a window
-- where they can reach stores they are not meant to.
create or replace function public.set_member_locations(p_member_id uuid, p_location_ids uuid[])
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_shop_id uuid;
begin
  select shop_id into v_shop_id from public.shop_members where id = p_member_id;
  if v_shop_id is null then
    raise exception 'member % not found', p_member_id;
  end if;
  if not public.has_shop_permission(v_shop_id, 'staff.manage') then
    raise exception 'not authorized to manage staff for shop %', v_shop_id;
  end if;

  -- Every id must belong to this member's shop. Without this a caller could
  -- assign someone to another business's store.
  if exists (
    select 1 from unnest(coalesce(p_location_ids, '{}'::uuid[])) as requested(id)
    where not exists (
      select 1 from public.shop_locations l where l.id = requested.id and l.shop_id = v_shop_id
    )
  ) then
    raise exception 'one or more stores do not belong to shop %', v_shop_id;
  end if;

  delete from public.shop_member_locations where shop_member_id = p_member_id;
  insert into public.shop_member_locations (shop_member_id, location_id)
    select p_member_id, requested.id
    from (select distinct unnest(coalesce(p_location_ids, '{}'::uuid[])) as id) requested
    on conflict do nothing;
end;
$$;
grant execute on function public.set_member_locations(uuid, uuid[]) to authenticated;
