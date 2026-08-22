-- Who changed the books, when, and what it was worth.
--
-- Accounting is the one part of the app where "the number is different today"
-- is a question someone has to be able to answer months later. Every other
-- screen can be reconstructed from its rows; a deleted expense cannot, and an
-- edited bill leaves no trace of what it used to say.
--
-- Three decisions worth stating:
--
--   **Append-only, enforced in the database.** There is no update policy and
--   no delete policy on this table, for anybody -- not the owner, not a
--   platform admin. A log a manager can edit is not a log.
--
--   **The summary is frozen at write time.** "Rent, $400.00" is stored as
--   text, not rebuilt later by joining back to a row that may since have been
--   renamed or deleted. The whole point is to survive the row.
--
--   **Triggers, not RPC calls.** Every one of these tables is writable through
--   ordinary RLS, so a log written by the client is a log with a hole in it
--   exactly where someone bypassed the client.

create table public.accounting_audit_log (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  occurred_at timestamptz not null default now(),
  -- Set null on user deletion, like every other actor column here. The frozen
  -- name below is what keeps the entry readable after.
  actor_id uuid references auth.users(id) on delete set null,
  actor_name text,
  action text not null check (action in ('create','update','delete','post','reverse','pay')),
  entity text not null check (entity in (
    'expense','invoice','invoice_payment','journal_entry','ledger_account',
    'cash_account','cash_transfer','fixed_asset','budget','recurring_bill'
  )),
  -- Not a foreign key, deliberately: the row it points at is allowed to be
  -- gone, and that is the case this table exists for.
  entity_id uuid,
  summary text not null,
  -- The money the change was about, so the log can be read as a list and
  -- filtered by size. Signed: a deletion is negative, because what a reader
  -- wants to find is the entry that took $2,000 out of the books.
  amount_cents integer,
  -- On an edit: only the columns that actually moved, as {column: {from, to}}.
  -- A whole-row snapshot is unreadable at the size this table grows to, and
  -- the interesting question is always what changed.
  --
  -- On a deletion: the whole row, because there is nothing left to compare it
  -- against and the row itself is the only record of what was lost.
  changes jsonb
);
create index accounting_audit_log_shop_idx on public.accounting_audit_log(shop_id, occurred_at desc);
create index accounting_audit_log_entity_idx on public.accounting_audit_log(shop_id, entity, entity_id);

alter table public.accounting_audit_log enable row level security;

-- Reading the log is a ledger-level act. Someone who can log an expense has no
-- business reading a list of everything everyone else did with the money.
create policy "read accounting_audit_log" on public.accounting_audit_log for select
  using (has_any_shop_permission(shop_id, array['ledger.view', 'ledger.manage']));

-- No insert policy either: entries arrive through the security-definer trigger
-- below, so a client cannot forge one.
grant select on public.accounting_audit_log to authenticated;

-- The name to freeze onto an entry. The shop's own roster first -- that is the
-- name the reader recognises -- then the profile, then the email's local part,
-- which is what the roster itself falls back to.
create or replace function public.audit_actor_name(p_shop_id uuid, p_user_id uuid)
returns text language sql security definer stable set search_path = public as $$
  select coalesce(
    (select nullif(m.full_name, '') from public.shop_members m
      where m.shop_id = p_shop_id and m.user_id = p_user_id),
    (select nullif(p.full_name, '') from public.profiles p where p.id = p_user_id),
    (select split_part(u.email, '@', 1) from auth.users u where u.id = p_user_id)
  );
$$;

-- Writes one entry. Called by the triggers below and directly by the ledger
-- RPCs, which know more about what they did than a trigger could work out.
create or replace function public.write_accounting_audit(
  p_shop_id uuid,
  p_action text,
  p_entity text,
  p_entity_id uuid,
  p_summary text,
  p_amount_cents integer default null,
  p_changes jsonb default null
) returns void
language plpgsql security definer set search_path = public as $$
begin
  -- The shop is going, or already gone.
  --
  -- Deleting a shop cascades into every table audited below, and Postgres
  -- removes the parent row BEFORE it processes the cascade -- so by the time
  -- the triggers fire there is no shop left for this row to point at, and the
  -- foreign key rejects it. That rejection does not just lose a log entry: it
  -- aborts the delete, and a shop that cannot be deleted is a considerably
  -- worse bug than an unlogged one.
  --
  -- Nothing is lost by skipping it. This table cascades on the same key, so
  -- every entry it holds for that shop is on its way out too; writing one more
  -- would only be deleted a moment later.
  if not exists (select 1 from public.shops where id = p_shop_id) then
    return;
  end if;

  insert into public.accounting_audit_log (shop_id, actor_id, actor_name, action, entity, entity_id, summary, amount_cents, changes)
    values (
      p_shop_id, auth.uid(), public.audit_actor_name(p_shop_id, auth.uid()),
      p_action, p_entity, p_entity_id, p_summary, p_amount_cents, p_changes
    );
end;
$$;

-- The columns worth logging a change to, per entity. Everything else -- an
-- `updated_at` bump, a re-saved note that came back identical -- is noise, and
-- a log that records noise is a log nobody reads.
create or replace function public.audit_tracked_columns(p_entity text)
returns text[] language sql immutable as $$
  select case p_entity
    when 'expense' then array['amount_cents','category','occurred_on','vendor_id','payment_method','note','location_id']
    when 'invoice' then array['amount_cents','category','issued_on','due_on','invoice_number','vendor_id','description','location_id']
    when 'ledger_account' then array['code','name','type','subtype','opening_balance_cents','opening_balance_on','archived','notes']
    when 'cash_account' then array['name','account_type','balance_cents','notes']
    when 'fixed_asset' then array['name','cost_cents','acquired_on','useful_life_months','salvage_value_cents','disposed_on','disposal_proceeds_cents','category','location_id']
    when 'budget' then array['category','limit_cents','location_id']
    when 'recurring_bill' then array['name','category','frequency','amount_cents','next_due_date','active','location_id']
    else array[]::text[]
  end;
$$;

-- One trigger function for every table, parameterised by TG_ARGV:
--   [0] the `entity` value
--   [1] an expression naming the row, evaluated against the row as jsonb
--
-- Generic on purpose. Eight near-identical trigger functions is eight places
-- for the log to quietly stop being written when a column is renamed.
create or replace function public.log_accounting_change() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_entity text := tg_argv[0];
  v_name_key text := tg_argv[1];
  v_row jsonb;
  v_old jsonb;
  v_shop_id uuid;
  v_label text;
  v_amount integer;
  v_changes jsonb := '{}'::jsonb;
  v_column text;
begin
  v_row := to_jsonb(coalesce(new, old));
  v_shop_id := (v_row->>'shop_id')::uuid;
  -- The name first, then the category -- an expense with no note typed on it
  -- still reads as "Rent" rather than as the bare word "expense".
  v_label := coalesce(nullif(v_row->>v_name_key, ''), nullif(v_row->>'category', ''), v_entity);
  -- Whichever of these the audited table happens to call its money column.
  v_amount := coalesce(
    (v_row->>'amount_cents')::integer,
    (v_row->>'cost_cents')::integer,
    (v_row->>'limit_cents')::integer
  );

  if tg_op = 'UPDATE' then
    v_old := to_jsonb(old);
    foreach v_column in array public.audit_tracked_columns(v_entity) loop
      -- `is distinct from` rather than `<>`, so a column going to or from NULL
      -- counts as a change instead of evaluating to NULL and being skipped.
      if (v_old->v_column) is distinct from (v_row->v_column) then
        v_changes := v_changes || jsonb_build_object(v_column, jsonb_build_object('from', v_old->v_column, 'to', v_row->v_column));
      end if;
    end loop;
    -- Nothing a reader would care about moved. Recording it anyway is how the
    -- log fills with entries that say "someone opened this and pressed save".
    if v_changes = '{}'::jsonb then return new; end if;
    perform public.write_accounting_audit(v_shop_id, 'update', v_entity, (v_row->>'id')::uuid, v_label, v_amount, v_changes);
    return new;
  end if;

  if tg_op = 'INSERT' then
    perform public.write_accounting_audit(v_shop_id, 'create', v_entity, (v_row->>'id')::uuid, v_label, v_amount, null);
    return new;
  end if;

  -- Negative on a deletion: the figure a reader scans this list for is the one
  -- that left the books, and printing it as a positive makes a $2,000 deletion
  -- look identical to a $2,000 entry.
  perform public.write_accounting_audit(v_shop_id, 'delete', v_entity, (v_row->>'id')::uuid, v_label, -coalesce(v_amount, 0), to_jsonb(old));
  return old;
end;
$$;

-- `after`, not `before`: a change that the row's own constraints reject must
-- not leave a log entry claiming it happened.
create trigger expenses_audit after insert or update or delete on public.expenses
  for each row execute function public.log_accounting_change('expense', 'note');
create trigger invoices_audit after insert or update or delete on public.invoices
  for each row execute function public.log_accounting_change('invoice', 'invoice_number');
create trigger ledger_accounts_audit after insert or update or delete on public.ledger_accounts
  for each row execute function public.log_accounting_change('ledger_account', 'name');
create trigger cash_accounts_audit after insert or update or delete on public.cash_accounts
  for each row execute function public.log_accounting_change('cash_account', 'name');
create trigger budgets_audit after insert or update or delete on public.budgets
  for each row execute function public.log_accounting_change('budget', 'category');
create trigger recurring_bills_audit after insert or update or delete on public.recurring_bills
  for each row execute function public.log_accounting_change('recurring_bill', 'name');

-- Bill payments are the one audited thing with no `shop_id` of its own, so
-- they get a function rather than the generic one. They are worth logging
-- separately from the bill: "the bill was for $400" and "someone recorded
-- $400 against it" are different claims, and a shop chasing a missing payment
-- needs the second.
create or replace function public.log_invoice_payment_change() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_row public.invoice_payments;
  v_invoice public.invoices%rowtype;
begin
  v_row := coalesce(new, old);
  select * into v_invoice from public.invoices where id = v_row.invoice_id;
  if v_invoice.id is null then return coalesce(new, old); end if;

  if tg_op = 'INSERT' then
    perform public.write_accounting_audit(
      v_invoice.shop_id, 'pay', 'invoice_payment', v_row.id,
      'Payment against bill ' || v_invoice.invoice_number, v_row.amount_cents, null
    );
    return new;
  end if;

  perform public.write_accounting_audit(
    v_invoice.shop_id, 'delete', 'invoice_payment', v_row.id,
    'Payment reversed on bill ' || v_invoice.invoice_number, -v_row.amount_cents, null
  );
  return old;
end;
$$;

create trigger invoice_payments_audit after insert or delete on public.invoice_payments
  for each row execute function public.log_invoice_payment_change();
