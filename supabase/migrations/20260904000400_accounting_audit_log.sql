-- Who changed what, when, and what it was before.
--
-- ## Why triggers rather than the RPCs
--
-- post_journal_entry could write its own audit row in two lines. It does not,
-- because then only what goes through post_journal_entry is audited -- and the
-- reason to keep a log is precisely the change that did NOT come through the
-- front door. A trigger on the table records the app, a migration, a
-- maintenance script and a psql session alike.
--
-- ## Why there is no delete policy, and no update policy
--
-- Not an oversight and not a default to be tightened later. A log that the
-- shop owner can prune is a log that says whatever its owner wants it to say,
-- which is worse than no log because it looks like evidence. The only way a
-- row leaves this table is the shop being deleted.
--
-- platform_audit_log (20260818000500) is the operator-side equivalent and is
-- deliberately separate: that one records what platform operators did to a
-- shop, this one records what the shop did to itself, and merging them would
-- put a support agent's actions and a bookkeeper's in one list where neither
-- audience can read theirs.

create table public.accounting_audit_log (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  -- Null for a change made by a migration or a maintenance script, which is a
  -- true and useful answer -- 'System' is what the reader is shown.
  actor_id uuid references auth.users(id),
  action text not null check (action in ('insert','update','delete')),
  subject_table text not null,
  subject_id uuid not null,
  -- The whole row, both sides. jsonb rather than a column list because this
  -- table outlives the shape of the tables it watches: a column added to
  -- journal_entries next year appears here with no migration.
  before jsonb,
  after jsonb,
  created_at timestamptz not null default now()
);
create index accounting_audit_log_shop_idx on public.accounting_audit_log(shop_id, created_at desc);
create index accounting_audit_log_subject_idx on public.accounting_audit_log(subject_table, subject_id);

create or replace function public.write_accounting_audit()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_row jsonb := to_jsonb(coalesce(new, old));
  v_shop uuid;
begin
  -- Every watched table carries shop_id directly except journal_lines, whose
  -- shop is on its entry. TG_ARGV[0] names the lookup rather than branching on
  -- TG_TABLE_NAME, so adding a fourth watched table is a trigger definition and
  -- not an edit to this function.
  if TG_ARGV[0] = 'via_entry' then
    select shop_id into v_shop from public.journal_entries
      where id = (v_row->>'entry_id')::uuid;
  else
    v_shop := (v_row->>'shop_id')::uuid;
  end if;

  -- The parent entry is already gone during a cascade delete. Nothing to
  -- attribute the row to, and the entry's own delete was audited a moment ago.
  if v_shop is null then return coalesce(new, old); end if;

  -- The SHOP is already gone when the delete cascading through here started at
  -- shops. Writing then is not merely pointless -- the audit row's own foreign
  -- key would refuse it, and the shop delete would fail with a message about a
  -- log table, which is how this was found (verify-owner-membership deletes a
  -- shop and started erroring the moment these triggers existed).
  --
  -- Pointless as well as impossible: accounting_audit_log cascades from shops,
  -- so any row written here would be deleted by the same statement that
  -- provoked it.
  if not exists (select 1 from public.shops where id = v_shop) then
    return coalesce(new, old);
  end if;

  insert into public.accounting_audit_log (shop_id, actor_id, action, subject_table, subject_id, before, after)
    values (v_shop, auth.uid(), lower(TG_OP), TG_TABLE_NAME,
            (v_row->>'id')::uuid,
            case when TG_OP = 'INSERT' then null else to_jsonb(old) end,
            case when TG_OP = 'DELETE' then null else to_jsonb(new) end);

  return coalesce(new, old);
end;
$$;

create trigger journal_entries_audited
  after insert or update or delete on public.journal_entries
  for each row execute function public.write_accounting_audit('direct');

create trigger journal_lines_audited
  after insert or update or delete on public.journal_lines
  for each row execute function public.write_accounting_audit('via_entry');

create trigger accounts_audited
  after insert or update or delete on public.accounts
  for each row execute function public.write_accounting_audit('direct');

create trigger accounting_periods_audited
  after insert or update or delete on public.accounting_periods
  for each row execute function public.write_accounting_audit('direct');

alter table public.accounting_audit_log enable row level security;

create policy "read accounting_audit_log" on public.accounting_audit_log for select
  using (has_shop_permission(shop_id, 'ledger.view'));

-- Deliberately no insert policy either: rows arrive only from the security
-- definer trigger above, which is not subject to RLS.
grant select on public.accounting_audit_log to authenticated;
