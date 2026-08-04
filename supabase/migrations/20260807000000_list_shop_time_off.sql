-- The Schedule tab's on-leave warning (scheduling.ts on_leave problem, unit
-- tested) needs to know who is on approved leave, but the only shop-wide read
-- policy on time_off_requests -- "approver manages shop time off requests" --
-- is gated on people.timeoff.approve alone. A member holding only
-- people.schedule.manage is neither an approver nor the requester, so RLS
-- silently drops every row: no error, onLeave comes back empty, and the
-- warning never fires for the exact role this feature is meant to delegate
-- to. It was invisible while only the owner (who satisfies every permission
-- gate) used the feature.
--
-- Same shape of fix as list_shop_staff (20260803010000): a security definer
-- function with a WIDER gate than the table policy, made safe by returning
-- LESS than the table has. Here that means the free-text `reason` column is
-- never returned at all -- a scheduler has a legitimate need to know a
-- teammate is off, not why. That omission is what makes the wider gate safe.
create or replace function public.list_shop_time_off(p_shop_id uuid, p_start_date date, p_end_date date)
returns table (
  shop_member_id uuid,
  start_date date,
  end_date date
)
language plpgsql security definer stable set search_path = public as $$
begin
  if not public.has_any_shop_permission(
    p_shop_id,
    array['people.schedule.manage', 'people.timeoff.approve']
  ) then
    raise exception 'not authorized for shop %', p_shop_id;
  end if;

  -- date_ranges carries the real (possibly non-contiguous) selection; older
  -- rows written before it existed have it backfilled to a single-element
  -- array (20260802030300), but default to '[]' on the column, so an empty
  -- array falls back to the row's own start_date/end_date the same way the
  -- client's mapTimeOffRow does.
  return query
    select
      t.shop_member_id,
      (span.value ->> 'startDate')::date as start_date,
      (span.value ->> 'endDate')::date as end_date
    from public.time_off_requests t
      cross join lateral jsonb_array_elements(
        case
          when jsonb_array_length(coalesce(t.date_ranges, '[]'::jsonb)) > 0 then t.date_ranges
          else jsonb_build_array(jsonb_build_object('startDate', t.start_date, 'endDate', t.end_date))
        end
      ) as span(value)
    where t.shop_id = p_shop_id
      and t.status = 'approved'
      and (span.value ->> 'startDate')::date <= p_end_date
      and (span.value ->> 'endDate')::date >= p_start_date;
end;
$$;

grant execute on function public.list_shop_time_off(uuid, date, date) to authenticated;
