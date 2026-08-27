-- The one setting that changes what the LEDGER does, gated in the database.
--
-- ## THE HOLE
--
-- 20261003000100 added `shops.auto_close_periods` and `shops.period_close_grace_days`,
-- and phase 3c put them behind a nav item that says so out loud
-- (settings-sidebar.tsx: "Gated on ledger.close for that reason"). The gate is
-- entirely in the client. The write is a plain PostgREST PATCH on `shops`
-- through updateShop(), and the `own shops update` policy admits:
--
--   owner_id = auth.uid() OR has_shop_permission(id, 'settings.access')
--
-- There is no column-level guard and there was no trigger. Measured -- a member
-- holding settings.access and no ledger permission at all:
--
--   has ledger.close? f   has settings.access? t
--   RESULT: auto_close_periods="automatic" written by settings.access with NO
--           ledger permission
--
-- It is bounded, which is why the review called it Minor: close_due_periods()
-- still refuses to fire for a caller without ledger.close, so the setting only
-- takes effect when a closer next opens the app; and only the seeded Owner role
-- holds settings.access today, and it holds ledger.close too. But the role
-- editor lets a shop grant office staff settings.access, and that arms it.
-- 20261005000200 exists precisely because "books do not close themselves" was
-- judged dangerous enough to change a shipped default and migrate every row; the
-- decision to turn that back on should sit behind the same permission as the act
-- itself.
--
-- ## WHY A TRIGGER AND NOT COLUMN PRIVILEGES
--
-- The obvious answer is `revoke update (auto_close_periods, ...) on shops from
-- authenticated`. PostgreSQL does not work that way: a role holding table-level
-- UPDATE may update every column, so the column grant only bites after the
-- TABLE grant is revoked and re-granted column by column -- which means naming
-- every other column of `shops` here, and silently breaking updateShop() for the
-- next column anybody adds. A trigger names the rule instead of the exceptions,
-- and it fires for any writer that reaches the table, not only for one grant.
--
-- ## THE ONE EXEMPTION, AND WHY IT IS NOT A HOLE
--
-- `auth.uid() is null` means there is no end user behind this statement: a
-- migration, a psql session, the service-role key. Those already bypass RLS
-- entirely, so a check on them would be theatre -- and without the exemption
-- this trigger would refuse 20261005000200's own backfill and every fixture that
-- sets the column before it has a session to set it with. The threat the gate is
-- for is an AUTHENTICATED caller holding settings.access, and that caller always
-- has a subject.
--
-- Both columns, not just the mode. period_close_grace_days IS the setting for a
-- shop already on 'automatic' -- dropping it from 30 to 0 closes every open
-- month on the next read -- so gating the mode and leaving the grace day count
-- open would be gating the switch and not the wire.

create or replace function public.guard_period_close_policy()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.auto_close_periods is distinct from old.auto_close_periods
     or new.period_close_grace_days is distinct from old.period_close_grace_days then
    if auth.uid() is not null
       and not public.has_shop_permission(new.id, 'ledger.close') then
      raise exception
        'You do not have permission to change when this shop''s books close.'
        using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists guard_period_close_policy on public.shops;
create trigger guard_period_close_policy
  before update on public.shops
  for each row execute function public.guard_period_close_policy();

comment on function public.guard_period_close_policy() is
  'Refuses a change to shops.auto_close_periods or shops.period_close_grace_days from an authenticated caller who does not hold ledger.close. The settings screen gates the panel on that permission and the `own shops update` policy does not -- it admits settings.access, which a shop can grant office staff -- so without this the decision to make the books close themselves sat behind a weaker gate than closing them. Fires for any writer that reaches the table, not only for one grant. A caller with no auth.uid() -- a migration, the service-role key, psql -- is exempt, because those bypass RLS anyway and the backfill in 20261005000200 is one of them.';
