-- How many sessions a register has, for the Settings panel that manages them.
--
-- A register can be deleted only while it has never been opened:
-- register_sessions.register_id references it `on delete restrict`, because
-- deleting a counter must not erase the money rung through it. Once it has any
-- history the answer is to deactivate, which keeps every session readable.
--
-- The panel therefore has to know which registers are deletable BEFORE offering
-- the button -- the house pattern (LocationsPanel passes `onDelete` only for a
-- location that can actually go). It cannot get that by counting
-- register_sessions directly, because "read shop register sessions"
-- (20260822000000) is gated on registers.manage / budgets.manage / sales.view,
-- and settings.access is deliberately none of those: managing which tills exist
-- is a different job from seeing who was short at close.
--
-- Adding settings.access to that policy would be the wrong fix -- it would hand
-- every settings user the cash variances to solve a counting problem. This
-- returns a COUNT and nothing else: no member, no float, no variance, no note.
-- Enough to know what may be deleted, and nothing about the money.
create or replace function public.register_session_counts(p_shop_id uuid)
returns table (register_id uuid, session_count bigint)
language sql security definer stable set search_path = public as $$
  select r.id, count(s.id)
    from public.registers r
    left join public.register_sessions s on s.register_id = r.id
   where r.shop_id = p_shop_id
     and public.has_any_shop_permission(
           p_shop_id, array['settings.access', 'registers.manage']
         )
   group by r.id;
$$;

grant execute on function public.register_session_counts(uuid) to authenticated;

comment on function public.register_session_counts(uuid) is
  'Session counts per register, so Settings can tell which registers are still
   deletable. Deliberately returns only a count -- the sessions themselves stay
   behind registers.manage / budgets.manage / sales.view.';
