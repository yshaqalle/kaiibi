-- A deleted branch must not block a delete_shop, and must not take its
-- history with it.
--
-- journal_entries.location_id and journal_lines.location_id were declared
-- with NO ON DELETE (20260904000300). That was latent through phase 1:
-- almost every manual entry left location_id null, so the constraint had
-- nothing to enforce. This branch (2b) makes every sale, refund,
-- settlement, delivery, count, payment and pay run stamp a location on its
-- entry and its lines, so the constraint now bites on ordinary data: a
-- platform admin's delete_shop cascades shops -> shop_locations, and
-- Postgres refuses to delete a shop_locations row that a journal_lines or
-- journal_entries row still points at --
--
--   ERROR: update or delete on table "shop_locations" violates foreign key
--   constraint "journal_lines_location_id_fkey" on table "journal_lines"
--
-- reproduced locally by posting one entry with a location and deleting its
-- shop.
--
-- ON DELETE SET NULL, not CASCADE. location_id is a DIMENSION -- which
-- branch the money moved at -- not part of a line's identity, and once the
-- location is gone the dimension is meaningless while the money it
-- describes still moved. CASCADE on journal_lines would delete individual
-- lines out of an already-balanced entry and leave the survivors summing to
-- something other than zero, which is exactly the property
-- assert_journal_balances (20260904000300) exists to make impossible to
-- violate. CASCADE on journal_entries would delete the entry itself, which
-- is worse: an entry that vanished mid-history breaks every report that
-- summed to it and the balance the deferred trigger guaranteed at the
-- moment it posted. SET NULL keeps the entry, keeps every line, keeps the
-- books balanced, and only loses the branch dimension for reports that
-- filter on it -- which is the same trade-off a shop already accepts for a
-- location-less manual entry today.
alter table public.journal_entries
  drop constraint journal_entries_location_id_fkey,
  add constraint journal_entries_location_id_fkey
    foreign key (location_id) references public.shop_locations(id) on delete set null;

alter table public.journal_lines
  drop constraint journal_lines_location_id_fkey,
  add constraint journal_lines_location_id_fkey
    foreign key (location_id) references public.shop_locations(id) on delete set null;

-- ---------------------------------------------------------------------------
-- The location fix above is not enough. Deleting a shop that has ever
-- traded STILL fails once location_id stops blocking it -- on the very next
-- FK in the same cascade, one that predates this branch entirely.
-- ---------------------------------------------------------------------------
--
-- journal_lines.account_id (`not null references public.accounts(id)`,
-- 20260904000300) and journal_entries.period_id (`not null references
-- public.accounting_periods(id)`, same migration) carry NO ON DELETE
-- either, and both `accounts.shop_id` and `accounting_periods.shop_id`
-- cascade from `shops` just like `shop_locations.shop_id` does. A shop's
-- chart of accounts and its accounting periods are torn down by the SAME
-- delete_shop cascade that tears down its journal -- they do not outlive
-- it, and they are not a dimension that can go missing while the entry
-- stays, the way a location is. So this is not a second instance of the
-- location bug; it is the same statement-level ordering problem showing up
-- one FK later:
--
--   ERROR: update or delete on table "accounts" violates foreign key
--   constraint "journal_lines_account_id_fkey" on table "journal_lines"
--
-- reproduced the same way, once the location_id fix above stopped masking
-- it -- a shop with one posted entry and no location fix would already have
-- hit this in phase 1, but almost nothing there posted a location-bearing
-- entry that survived long enough to also be a delete_shop candidate.
--
-- account_id and period_id cannot take SET NULL -- both are NOT NULL, and
-- rightly so: a line with no account, or an entry with no period, describes
-- nothing. They cannot take CASCADE either, for the reason location_id's
-- comment already gives: deleting one line out of a balanced entry, or one
-- entry whose period closed, breaks a property this schema does not let
-- anything else break.
--
-- What actually needs to change is not WHAT happens on delete, but WHEN it
-- is checked. `accounts.shop_id` (20260904000100) and
-- `accounting_periods.shop_id` (20260904000200) cascade-fire earlier in
-- the same statement than `journal_entries.shop_id` (20260904000300) does,
-- so Postgres tries to delete an account or a period while a journal_lines
-- or journal_entries row still points at it -- even though that row is
-- ITSELF about to be deleted, by the same statement, a moment later. A
-- NOT DEFERRABLE constraint checks that instant and finds a violation that
-- will not exist once the statement finishes. Making both constraints
-- DEFERRABLE INITIALLY DEFERRED moves the check to the end of the
-- transaction, by which point every cascade branch of the same delete_shop
-- has completed and nothing is left pointing at a dead account or period.
-- Verified directly: with both changes, the same reproduction posts an
-- entry, deletes the shop, and the transaction commits clean.
--
-- This does not weaken the guard the original comment describes. There is
-- no live path that deletes a single `accounts` row (`archived_at` is read
-- everywhere and written nowhere -- archiving is not wired up yet either),
-- so the constraint's only practical effect, before or after this change,
-- is on the delete_shop cascade this migration exists to fix. Deferred, it
-- still refuses to commit a transaction that leaves a dangling reference;
-- it only stops refusing one that was always going to resolve itself by
-- commit time.
alter table public.journal_lines
  drop constraint journal_lines_account_id_fkey,
  add constraint journal_lines_account_id_fkey
    foreign key (account_id) references public.accounts(id) deferrable initially deferred;

alter table public.journal_entries
  drop constraint journal_entries_period_id_fkey,
  add constraint journal_entries_period_id_fkey
    foreign key (period_id) references public.accounting_periods(id) deferrable initially deferred;

-- ---------------------------------------------------------------------------
-- ON DELETE SET NULL is itself an UPDATE, and this schema already has a
-- trigger whose entire job is to refuse an UPDATE to a posted row. Found by
-- the verify-ledger.sql check this migration adds -- 22b posts an entry,
-- deletes ONLY its location (not its shop), and hit:
--
--   ERROR: A posted entry is immutable. Reverse it instead of editing it.
--   CONTEXT: ... refuse_posted_entry_edit() ...
--   SQL statement "UPDATE ONLY journal_entries SET location_id = NULL ..."
--
-- refuse_posted_entry_edit() (20260904000300) permits exactly one UPDATE
-- shape on a posted entry -- the reversal transition -- and raises on every
-- other one, which is precisely what SET NULL's own UPDATE is. Without this
-- clause the fix two sections up is not reachable at all for any entry that
-- is actually posted, which is every entry post_journal_entry ever writes.
-- refuse_posted_line_change() guards journal_lines the same way, one level
-- stricter -- it blocks on the parent entry being anything but 'draft', so
-- a REVERSED entry's lines are covered by the same gap.
--
-- Both functions gain a second permitted transition, shaped the same way
-- the reversal one is: location_id is the ONLY column allowed to move, and
-- only from not-null to null. Recreated in full, matching this file's
-- convention -- CREATE OR REPLACE cannot add a clause without the whole
-- body being present.
create or replace function public.refuse_posted_entry_edit()
returns trigger
language plpgsql set search_path = public as $$
begin
  -- The one legal transition on a posted row: reverse_journal_entry marking it
  -- reversed and pointing it at its mirror. Everything else about the row must
  -- be identical, which is what the row comparison below checks -- listing
  -- columns by name would silently stop covering any column added later.
  --
  -- IS NOT DISTINCT FROM, never =. A row comparison containing a null on both
  -- sides evaluates to NULL rather than true, so `=` here refused every
  -- reversal of an entry with no location_id -- which is every entry a
  -- single-store shop writes. The reversal failed with "A posted entry is
  -- immutable", accusing the one function allowed to make this change.
  if old.status = 'posted' and new.status = 'reversed'
     and new.reverses_entry_id is not null
     and (new.id, new.shop_id, new.period_id, new.entry_date, new.reference,
          new.description, new.source, new.location_id, new.created_by, new.created_at)
       is not distinct from
         (old.id, old.shop_id, old.period_id, old.entry_date, old.reference,
          old.description, old.source, old.location_id, old.created_by, old.created_at) then
    return new;
  end if;

  -- The other legal transition, added by 20260908001200: the FK's ON DELETE
  -- SET NULL clearing location_id when the branch it pointed at is deleted
  -- -- delete_shop cascading through the whole shop, or deleteLocation()
  -- (src/lib/locations.ts) removing one branch on its own. location_id is
  -- the only column allowed to change, and only from not-null to null;
  -- status and reverses_entry_id are listed explicitly (unlike the block
  -- above) because this transition must NOT be confused with a reversal --
  -- a posted entry stays posted, a reversed one stays reversed.
  if old.location_id is not null and new.location_id is null
     and (new.id, new.shop_id, new.period_id, new.entry_date, new.reference,
          new.description, new.source, new.status, new.reverses_entry_id,
          new.created_by, new.created_at)
       is not distinct from
         (old.id, old.shop_id, old.period_id, old.entry_date, old.reference,
          old.description, old.source, old.status, old.reverses_entry_id,
          old.created_by, old.created_at) then
    return new;
  end if;

  if old.status = 'posted' then
    raise exception 'A posted entry is immutable. Reverse it instead of editing it.'
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

create or replace function public.refuse_posted_line_change()
returns trigger
language plpgsql set search_path = public as $$
declare
  v_status text;
begin
  -- The same second transition as refuse_posted_entry_edit(), and for the
  -- same reason: ON DELETE SET NULL on journal_lines.location_id is an
  -- UPDATE, and without this clause it is indistinguishable from someone
  -- editing a posted line by hand. TG_OP = 'UPDATE' guards the comparison --
  -- this trigger also fires BEFORE DELETE, where NEW is null and every field
  -- of it would read as NULL IS NOT DISTINCT FROM NULL, matching by accident.
  if tg_op = 'UPDATE' and old.location_id is not null and new.location_id is null
     and (new.id, new.entry_id, new.account_id, new.amount_cents, new.memo)
       is not distinct from
         (old.id, old.entry_id, old.account_id, old.amount_cents, old.memo) then
    return new;
  end if;

  select status into v_status from public.journal_entries
    where id = coalesce(new.entry_id, old.entry_id);
  -- Null when the parent entry is already gone: this is the ON DELETE CASCADE
  -- tearing down a draft, not somebody editing a posted one.
  if v_status is not null and v_status <> 'draft' then
    raise exception 'The lines of a posted entry are immutable. Reverse the entry instead.'
      using errcode = 'P0001';
  end if;
  return coalesce(new, old);
end;
$$;
