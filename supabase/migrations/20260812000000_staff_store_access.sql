-- Access is (store, role): a person is a cashier AT a particular store.
--
-- Roles already answered "what may this person do" (0017/0024). They did not
-- answer "where", so a cashier hired for one store could ring sales into
-- another, decrement its stock and read its takings. With one store that was
-- unobservable. With two it is the whole point.
--
-- ## Null means every store, deliberately
--
-- A member with no store assigned works at all of them. That is what an owner,
-- an area manager or a floating staff member actually is, and it is also what
-- every existing member becomes when this migration runs -- so nobody is locked
-- out of anything the morning after it applies. Restricting someone is then an
-- explicit act, which is the right direction for a change that removes access.
--
-- ## What this does NOT do
--
-- One store per person, or all of them. "Cashier at A and B but not C" and
-- "cashier at A, manager at B" both need a shop_member_locations join table
-- carrying its own role, which is a bigger change than the need that prompted
-- this. The column below is forward-compatible with that: the join table would
-- supersede it, and this column becomes the single-assignment fast path.
--
-- ## Why no `on delete` clause
--
-- Left to RESTRICT on purpose. `on delete set null` would silently PROMOTE a
-- restricted member to all-stores access the moment their store was deleted --
-- a privilege escalation triggered by an unrelated admin action. Refusing the
-- delete instead is correct, and costs nothing: a store that has traded can't
-- be deleted anyway (its sales reference it), and the Store locations panel
-- already steers closure toward `active = false`.

alter table public.shop_members
  add column location_id uuid references public.shop_locations(id);

comment on column public.shop_members.location_id is
  'Which store this person works at. Null = every store (owners, area managers, floating staff). Enforced by can_access_location().';

create index shop_members_location_idx on public.shop_members(location_id);

-- ---------------------------------------------------------------------------
-- Enforcement
-- ---------------------------------------------------------------------------

-- Until now this returned true for any active member of the shop, because
-- there was no assignment to check -- 20260808000000 says as much, and notes
-- that the null default is what keeps tightening it from locking anyone out.
-- This is that tightening.
--
-- Still security definer for the reason given there: shop_members is readable
-- only with staff.manage and friends, so an inline `exists` in a policy would
-- evaluate under the caller's RLS, see zero rows, and deny everyone.
--
-- The owner keeps unconditional access to every store. They have no
-- shop_members row at all (0017), so there is nothing to assign them to.
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
            -- The assignment check. Null is "every store", so an unassigned
            -- member matches any location in their shop.
            and (m.location_id is null or m.location_id = l.id)
        )
      )
  );
$$;

-- The stores this user may operate at, for the client to build its store
-- switcher from. Without it the switcher would offer every store in the shop
-- and let a cashier pick one the database will then refuse, which reads as a
-- bug rather than as a permission.
--
-- Returns ids only: shop_locations is already member-readable (20260808000000),
-- so the client joins the details it already has rather than this duplicating
-- them and drifting.
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
          and (m.location_id is null or m.location_id = l.id)
      )
    );
$$;
grant execute on function public.my_location_ids(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Roster listing
-- ---------------------------------------------------------------------------

-- list_shop_staff declares an explicit return column list (see 20260803010000
-- and 20260804030000 for why: a column added to the table but not here comes
-- back undefined rather than wrong-but-visible). Adding location_id therefore
-- means dropping and recreating rather than replacing in place -- Postgres
-- refuses `create or replace` when the returns-table column list changes.
--
-- location_id is NOT pay-gated. Which store a colleague works at is roster
-- information any of these roles legitimately needs -- a scheduler must know
-- who staffs which store -- unlike pay, which stays behind
-- people.payroll.manage.
drop function if exists public.list_shop_staff(uuid);

create function public.list_shop_staff(p_shop_id uuid)
returns table (
  id uuid,
  shop_id uuid,
  user_id uuid,
  role_id uuid,
  role_name text,
  location_id uuid,
  location_name text,
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
      m.location_id,
      l.name as location_name,
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
      left join public.shop_locations l on l.id = m.location_id
    where m.shop_id = p_shop_id
    order by m.created_at;
end;
$$;

grant execute on function public.list_shop_staff(uuid) to authenticated;
