-- Registers, and the count at each end of a session.
--
-- A sale already records which branch (location_id), which auth user
-- (created_by) and a cashier_name -- but cashier_name is a frozen string copied
-- from `cashiers`, a per-location list of labels with no user_id and no link to
-- shop_members. So the shop cannot answer the question that matters at
-- handover: who was on this till this afternoon, what did they start with, what
-- did they hand over, and is it short?
--
-- NAMING. This is a "register session", never a "shift". `shifts`
-- (20260806000000) already means the rota -- who is scheduled to come in -- and
-- `time_entries` already means clocked hours. A cash boundary is a third thing
-- and reusing either word would collide with a live, different meaning.
--
-- A REGISTER IS DURABLE, NOT PHYSICAL. Define it as "a durable named place a
-- sale is rung from": usually a counter with a drawer, sometimes a person's
-- phone. registers.id outlives every session opened on it; register_sessions.id
-- is one open->close cycle. Collapsing the two -- creating a register at open
-- and dropping it at close -- would make every session an island and kill the
-- reporting this exists for ("is register 2 short three days running", "which
-- register takes most on a Friday"). The durable id IS the reporting.
--
-- THE DRAWER IS PER CURRENCY. A Hargeisa drawer holds USD and SLSH at once, so
-- a session does not have "a float" -- it has one float, one expected figure,
-- one counted figure and one variance per currency, at open and at close alike.
-- See register_session_cash below, and register_session_expected() for why the
-- two are never differenced against each other.

-- ---------------------------------------------------------------------------
-- Settings: one on the place, one on the business
-- ---------------------------------------------------------------------------

-- On the LOCATION, not the shop, and for the reason 20260821000000 states when
-- it puts merchant ids here: shop-level settings are commercial decisions made
-- once for the business, location-level ones are physical facts about a place.
-- "Does this branch count its drawer?" is the second kind. A flagship with three
-- tills and four cashiers wants it enforced; the kiosk across town, where the
-- owner is the only person behind the counter, does not -- and one business runs
-- both. It sits alongside opening_hours, contact_phone and the scanner flags
-- already on this table.
--
-- Off by default, and that is not timidity: every existing branch is mid-trade.
-- Shipping a hard requirement would break a working counter to introduce a
-- feature that shop never asked for. A branch that WANTS the accountability
-- turns it on, and then it has to be enforceable or staff will skip the count on
-- a busy day.
alter table public.shop_locations
  add column if not exists require_open_register boolean not null default false;

-- The notes the note-by-note tally offers, keyed by currency code, in that
-- currency's MINOR unit (same convention as sale_payments.foreign_amount_cents).
--
-- Keyed by code on the shop rather than a column on shop_currencies because USD
-- is deliberately not a row in that table -- migration 0015 makes it the
-- implicit default when currency_code is null. A shop column for dollars and a
-- currency column for everything else would be two homes for one setting.
--
-- This is a STARTING POINT, not a constraint. The tally lets a cashier add a
-- denomination the list does not know about, because a seeded list is
-- guaranteed to be wrong somewhere and the moment it is, the person is holding
-- a note the app refuses to acknowledge. Counts are stored keyed by note VALUE
-- (see register_session_cash), never as a foreign key into this list, so the
-- list can grow or change without rewriting history.
alter table public.shops
  add column if not exists cash_denominations jsonb not null default
    '{"USD": [10000, 5000, 2000, 1000, 500, 100],
      "SLSH": [1000000, 500000, 100000, 50000, 10000]}'::jsonb;

comment on column public.shops.cash_denominations is
  'Note values offered by the drawer tally, keyed by currency code, in minor
   units. A starting point -- the tally accepts values not listed here.';

-- ---------------------------------------------------------------------------
-- registers
-- ---------------------------------------------------------------------------

create table if not exists public.registers (
  id             uuid primary key default gen_random_uuid(),
  shop_id        uuid not null references public.shops(id) on delete cascade,
  -- NOT NULL for counters and phones alike. A mobile seller still sells
  -- SOMEWHERE, and stock, takings and staff access are all branch-scoped in
  -- this app -- a register with no branch would be a hole in every one of them.
  -- Follows the operational-table precedent (sales, cashiers, cash_accounts;
  -- 20260815000000), not the nullable accounting one.
  location_id    uuid not null references public.shop_locations(id) on delete cascade,
  name           text not null check (length(btrim(name)) > 0),
  kind           text not null default 'counter' check (kind in ('counter', 'mobile')),
  -- Whose phone, for kind='mobile'. Null for a counter: a till belongs to the
  -- shop, not to whoever happens to be standing at it.
  shop_member_id uuid references public.shop_members(id) on delete set null,
  active         boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (location_id, name),
  constraint registers_mobile_has_member check (kind <> 'mobile' or shop_member_id is not null)
);

create index if not exists registers_shop_idx on public.registers(shop_id);
create index if not exists registers_location_idx on public.registers(location_id);
-- ensure_mobile_register() looks a person's own register up by this pair.
create index if not exists registers_member_idx on public.registers(shop_member_id)
  where shop_member_id is not null;

-- ---------------------------------------------------------------------------
-- register_sessions
-- ---------------------------------------------------------------------------

create table if not exists public.register_sessions (
  id             uuid primary key default gen_random_uuid(),
  shop_id        uuid not null references public.shops(id) on delete cascade,
  location_id    uuid not null references public.shop_locations(id) on delete cascade,
  -- restrict, not cascade: deleting a counter must not erase its money history.
  -- Registers are deactivated once they have sessions, never deleted.
  register_id    uuid not null references public.registers(id) on delete restrict,
  shop_member_id uuid not null references public.shop_members(id) on delete restrict,
  -- Who performed the open. Differs from shop_member_id when a supervisor sets
  -- a float up for a cashier, which is the common real-world case.
  opened_by      uuid references auth.users(id),
  opened_at      timestamptz not null default now(),
  closed_at      timestamptz,
  closed_by      uuid references auth.users(id),
  -- Sum of the per-currency variances, each converted at ITS OWN closing rate.
  -- Frozen here at close and never recomputed: a later refund, sale edit or
  -- rate change must not silently rewrite a figure somebody signed off. Same
  -- reasoning as sales.cashier_name, sale_items.unit_cost_cents and
  -- sale_payments.exchange_rate.
  variance_base_cents integer,
  opening_note   text,
  closing_note   text,
  created_at     timestamptz not null default now(),
  constraint register_sessions_closed_together
    check ((closed_at is null) = (closed_by is null))
);

-- One open session per register. Same device time_entries_open_idx uses for one
-- open clock-in per member.
create unique index if not exists register_sessions_open_idx
  on public.register_sessions(register_id) where closed_at is null;
create index if not exists register_sessions_shop_opened_idx
  on public.register_sessions(shop_id, opened_at desc);
-- "Takings by register" is served from here rather than by denormalising
-- register_id onto sales: a session can never move to another register, so
-- copying that id would only create a second place for the truth to live.
create index if not exists register_sessions_register_idx
  on public.register_sessions(register_id, opened_at desc);
create index if not exists register_sessions_member_idx
  on public.register_sessions(shop_member_id, opened_at desc);

-- ---------------------------------------------------------------------------
-- register_session_cash -- one row per currency in the drawer
-- ---------------------------------------------------------------------------

create table if not exists public.register_session_cash (
  id         uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.register_sessions(id) on delete cascade,
  -- Base rows are written literally as 'USD', diverging from sale_payments
  -- where null means USD (0015's "USD is the implicit default"). Deliberate:
  -- Postgres unique indexes treat nulls as distinct, so a nullable code here
  -- would let one session accumulate several base-currency rows.
  currency_code text not null check (length(btrim(currency_code)) > 0),
  -- Everything below is in this currency's MINOR unit.
  opening_float_minor   integer not null default 0 check (opening_float_minor >= 0),
  -- Snapshotted at both ends. Reading the rate live at report time would
  -- re-convert last Tuesday's signed-off close at today's rate and quietly
  -- change it.
  opening_rate_to_usd   numeric not null check (opening_rate_to_usd > 0),
  closing_counted_minor integer check (closing_counted_minor >= 0),
  closing_rate_to_usd   numeric check (closing_rate_to_usd > 0),
  expected_minor        integer,
  variance_minor        integer,
  -- {"10000": 2, "5000": 3, "other": 350} -- keyed by note VALUE in minor
  -- units, plus the catch-all "other" key carrying a plain amount. Never a
  -- foreign key into shops.cash_denominations, so an unseeded note is simply
  -- another key and a stored breakdown stays readable after the list is edited.
  opening_denominations jsonb,
  closing_denominations jsonb,
  unique (session_id, currency_code)
);

create index if not exists register_session_cash_session_idx
  on public.register_session_cash(session_id);

-- ---------------------------------------------------------------------------
-- Attaching sales and refunds to a session
-- ---------------------------------------------------------------------------

-- Nullable, because CSV import, older clients and every shop that never opens a
-- register must keep working exactly as they do today.
alter table public.sales
  add column if not exists register_session_id uuid references public.register_sessions(id) on delete set null;
create index if not exists sales_register_session_idx
  on public.sales(register_session_id) where register_session_id is not null;

alter table public.refunds
  add column if not exists register_session_id uuid references public.register_sessions(id) on delete set null;
create index if not exists refunds_register_session_idx
  on public.refunds(register_session_id) where register_session_id is not null;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

-- security definer for the reason spelled out at length in 20260806000000: an
-- inline `exists (select 1 from shop_members ...)` inside a policy or a WITH
-- CHECK runs under the CALLER's RLS, and shop_members is only readable with
-- staff.manage and friends -- so it would see zero rows for an ordinary cashier
-- and deny them their own register.
create or replace function public.my_shop_member_id(p_shop_id uuid)
returns uuid
language sql security definer stable set search_path = public as $$
  select m.id from public.shop_members m
   where m.shop_id = p_shop_id and m.user_id = auth.uid() and m.active
   limit 1;
$$;
grant execute on function public.my_shop_member_id(uuid) to authenticated;

-- The session the caller currently has open at a location, if any. Used by the
-- refunds trigger below and by the POS to resolve state in one round trip.
create or replace function public.my_open_session_at(p_location_id uuid)
returns uuid
language sql security definer stable set search_path = public as $$
  select s.id from public.register_sessions s
    join public.shop_members m on m.id = s.shop_member_id
   where s.location_id = p_location_id
     and s.closed_at is null
     and m.user_id = auth.uid()
     and m.active
   order by s.opened_at desc
   limit 1;
$$;
grant execute on function public.my_open_session_at(uuid) to authenticated;

-- A refund pays cash OUT of whichever drawer the person issuing it is standing
-- at -- which is not necessarily the session that took the original sale. A
-- refund on Tuesday against Monday's sale comes out of Tuesday's till.
--
-- A trigger rather than a parameter on refund_sale_items because that RPC is
-- ~200 lines of proportional-allocation arithmetic (20260820000200) and
-- reproducing it whole to thread one derivable value through would be a large
-- change for no added correctness: the answer is a pure function of the caller
-- and the sale's location, which is exactly what a trigger can see.
--
-- Null when the refunder has no register open, which is the honest answer: the
-- money did not come out of a till this app is tracking.
create or replace function public.attach_refund_to_session()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_location_id uuid;
begin
  if new.register_session_id is not null then
    return new;
  end if;
  select location_id into v_location_id from public.sales where id = new.sale_id;
  if v_location_id is null then
    return new;
  end if;
  new.register_session_id := public.my_open_session_at(v_location_id);
  return new;
end;
$$;

drop trigger if exists refunds_attach_session on public.refunds;
create trigger refunds_attach_session before insert on public.refunds
  for each row execute function public.attach_refund_to_session();

-- ---------------------------------------------------------------------------
-- register_session_expected -- the arithmetic, per currency
-- ---------------------------------------------------------------------------

-- Returns one row per currency the session has cash in, with what the drawer
-- SHOULD hold. Two traps this navigates, both verified against the code:
--
--  1. sale_payments.tendered_cents is only written when change was given
--     (payment-method-picker.tsx), so it is null for exact-tender cash and
--     cannot be summed. amount_cents is what was applied and is what stayed.
--
--  2. On a FOREIGN cash line, amount_cents is the USD equivalent applied to the
--     sale -- 0015 calls the currency columns "display/audit only" -- while the
--     money that physically entered the drawer is foreign_amount_cents. So the
--     base figure must EXCLUDE cash lines carrying a currency_code, or every
--     shilling sale is counted twice: once as dollars that were never in the
--     drawer, and again as the shillings that were.
--
-- Refunds are allocated proportionally: `refunds` records a total but no tender
-- breakdown, and 20260820000200's whole premise is that a refund returns what
-- was paid. So each refund contributes its total scaled by the share of the
-- original sale that was settled in that cash bucket.
create or replace function public.register_session_expected(p_session_id uuid)
returns table (currency_code text, expected_minor integer)
language sql security definer stable set search_path = public as $$
  with cash_in as (
    -- Base currency: cash with no currency_code, in USD cents.
    select 'USD'::text as code,
           sum(sp.amount_cents)::numeric as amount
      from public.sale_payments sp
      join public.sales s on s.id = sp.sale_id
     where s.register_session_id = p_session_id
       and sp.method = 'cash'
       and sp.currency_code is null
    having sum(sp.amount_cents) is not null
    union all
    -- Foreign currencies: the notes that actually moved, in their own minor
    -- unit. Change leaves the same pile it came from (the picker converts the
    -- change back at the line's own rate), so it nets off here.
    select sp.currency_code,
           sum(sp.foreign_amount_cents - coalesce(sp.foreign_change_cents, 0))::numeric
      from public.sale_payments sp
      join public.sales s on s.id = sp.sale_id
     where s.register_session_id = p_session_id
       and sp.method = 'cash'
       and sp.currency_code is not null
     group by sp.currency_code
  ),
  -- Per refund, the share of the original sale settled in each cash bucket.
  refund_share as (
    select coalesce(sp.currency_code, 'USD') as code,
           sum(
             r.total_cents::numeric
             * (case when sp.currency_code is null then sp.amount_cents else sp.amount_cents end)::numeric
             / nullif(s.total_cents, 0)
             -- Foreign buckets are held in their own minor unit, so convert the
             -- USD-denominated share back at the rate that line was taken at.
             * (case when sp.currency_code is null then 1 else coalesce(sp.exchange_rate, 1) end)
           ) as amount
      from public.refunds r
      join public.sales s on s.id = r.sale_id
      join public.sale_payments sp on sp.sale_id = s.id and sp.method = 'cash'
     where r.register_session_id = p_session_id
     group by coalesce(sp.currency_code, 'USD')
  )
  select c.currency_code,
         round(
           c.opening_float_minor
           + coalesce((select ci.amount from cash_in ci where ci.code = c.currency_code), 0)
           - coalesce((select rs.amount from refund_share rs where rs.code = c.currency_code), 0)
         )::integer
    from public.register_session_cash c
   where c.session_id = p_session_id;
$$;
grant execute on function public.register_session_expected(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

alter table public.registers enable row level security;
alter table public.register_sessions enable row level security;
alter table public.register_session_cash enable row level security;

-- Reading which registers exist is part of using the POS. Creating and renaming
-- them is a Settings act -- the same bar CashiersPanel sits behind.
create policy "read registers" on public.registers for select
  using (has_any_shop_permission(shop_id, array['pos.access', 'settings.access', 'registers.manage', 'sales.view']));
create policy "write registers" on public.registers for all
  using (has_any_shop_permission(shop_id, array['settings.access', 'registers.manage']))
  with check (has_any_shop_permission(shop_id, array['settings.access', 'registers.manage']));

-- The own-row escape hatch, mirroring "read own shifts" (20260806000000)
-- exactly: active membership AND matching shop_id, both required. Without the
-- shop_id agreement a session row for a member of another shop would still be
-- readable by that member.
create policy "read own register sessions" on public.register_sessions for select
  using (exists (
    select 1 from public.shop_members m
     where m.id = shop_member_id and m.user_id = auth.uid() and m.active
       and m.shop_id = register_sessions.shop_id
  ));
create policy "read shop register sessions" on public.register_sessions for select
  using (has_any_shop_permission(shop_id, array['registers.manage', 'budgets.manage', 'sales.view']));

-- No write policy on purpose. Opening, closing and handing over all go through
-- the security-definer RPCs below, which is what makes "one open session per
-- register", "the float you claim is not the float we record" and "expected is
-- computed server-side" enforceable rather than advisory.

create policy "read register session cash" on public.register_session_cash for select
  using (exists (
    select 1 from public.register_sessions s
     where s.id = session_id
       and (
         has_any_shop_permission(s.shop_id, array['registers.manage', 'budgets.manage', 'sales.view'])
         or exists (
           select 1 from public.shop_members m
            where m.id = s.shop_member_id and m.user_id = auth.uid() and m.active
              and m.shop_id = s.shop_id
         )
       )
  ));

grant select, insert, update, delete on public.registers to authenticated;
grant select on public.register_sessions to authenticated;
grant select on public.register_session_cash to authenticated;

-- Module gating is a BEFORE trigger, not a policy, for the reason
-- 20260818000400 gives at length: security-definer RPCs bypass RLS entirely but
-- cannot bypass a trigger. DELETE is never gated.
drop trigger if exists registers_module on public.registers;
create trigger registers_module before insert or update on public.registers
  for each row execute function public.enforce_shop_module('pos');

drop trigger if exists register_sessions_module on public.register_sessions;
create trigger register_sessions_module before insert or update on public.register_sessions
  for each row execute function public.enforce_shop_module('pos');

-- ---------------------------------------------------------------------------
-- ensure_mobile_register
-- ---------------------------------------------------------------------------

-- A phone is a register too, and it still gets a durable id. Auto-provisioned
-- the first time someone opens a session with no counter free, then REUSED --
-- which is the whole point. A register recreated per session could never answer
-- "how did this seller do this month".
create or replace function public.ensure_mobile_register(
  p_shop_id uuid,
  p_location_id uuid,
  p_shop_member_id uuid default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_member_id uuid := coalesce(p_shop_member_id, public.my_shop_member_id(p_shop_id));
  v_name text;
  v_register_id uuid;
begin
  if not public.has_shop_permission(p_shop_id, 'pos.access') then
    raise exception 'not authorized for shop %', p_shop_id;
  end if;
  if not public.can_access_location(p_location_id) then
    raise exception 'not authorized for location %', p_location_id;
  end if;
  if v_member_id is null then
    raise exception 'no active membership in shop % for this user', p_shop_id;
  end if;

  select id into v_register_id from public.registers
   where shop_id = p_shop_id and location_id = p_location_id
     and kind = 'mobile' and shop_member_id = v_member_id
   limit 1;
  if v_register_id is not null then
    -- Reactivate rather than create a second one: a seller who came back after
    -- a spell away should keep their history, not start a parallel register.
    update public.registers set active = true, updated_at = now()
      where id = v_register_id and not active;
    return v_register_id;
  end if;

  select coalesce(nullif(btrim(m.full_name), ''), 'Mobile') into v_name
    from public.shop_members m where m.id = v_member_id;

  -- The unique (location_id, name) index is what makes this safe under two
  -- devices opening at once: the loser of the race takes the on-conflict branch
  -- and reads the winner's row rather than creating a duplicate.
  insert into public.registers (shop_id, location_id, name, kind, shop_member_id)
    values (p_shop_id, p_location_id, v_name || ' — mobile', 'mobile', v_member_id)
    on conflict (location_id, name) do update set updated_at = now()
    returning id into v_register_id;

  return v_register_id;
end;
$$;
grant execute on function public.ensure_mobile_register(uuid, uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- open_register_session
-- ---------------------------------------------------------------------------

-- p_cash is a jsonb array of
--   {currency_code, amount_minor, rate_to_usd, denominations}
-- one entry per currency in the drawer -- never a scalar. It may be EMPTY: a
-- phone seller taking only mobile money opens with no float and no cash rows.
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
  v_session_id uuid;
  v_entry jsonb;
  v_code text;
  v_rate numeric;
begin
  -- Locked before anything is read off it, so two taps on "Open register"
  -- cannot both see it free and both open.
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

  v_member_id := coalesce(p_shop_member_id, public.my_shop_member_id(v_register.shop_id));
  if v_member_id is null then
    raise exception 'no active membership in shop % for this user', v_register.shop_id;
  end if;
  if not public.shop_member_in_shop(v_member_id, v_register.shop_id) then
    raise exception 'member % does not belong to shop %', v_member_id, v_register.shop_id;
  end if;

  -- Opening a register FOR SOMEONE ELSE is the act that needs its own gate:
  -- setting a float against another person's name is what a supervisor does,
  -- and it is what makes them accountable for it.
  if v_member_id is distinct from public.my_shop_member_id(v_register.shop_id)
     and not public.has_shop_permission(v_register.shop_id, 'registers.manage') then
    raise exception 'not authorized to open a register for another person';
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
    -- Defaulted from the shop's own table when the client did not send one, so
    -- a rate is never absent; editable at the counter because the street rate
    -- moves faster than Settings does.
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
grant execute on function public.open_register_session(uuid, uuid, jsonb, text) to authenticated;

-- ---------------------------------------------------------------------------
-- close_register_session
-- ---------------------------------------------------------------------------

-- p_cash has the same shape as open's. Expected is computed here, server-side,
-- and the client's idea of it is never trusted -- the client is the party the
-- number is checking.
--
-- ORDER OF OPERATIONS IS THE WHOLE DESIGN. Each currency is differenced against
-- its OWN expected figure first, with no rate involved. Only the resulting
-- variances are converted and summed. Doing it the other way round -- convert
-- the balances, difference those -- reports roughly $80 of variance on a
-- 355,000 SLSH drawer when the rate drifts 115 -> 118 and every note stayed
-- exactly where it was, which is a fabricated accusation against whoever was on
-- the register. Converting a -$5 variance at 115 or at 118 changes it by pennies.
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
  -- Your own session, or you hold registers.manage. Signing off someone else's
  -- variance is a supervisory act.
  if v_session.shop_member_id is distinct from public.my_shop_member_id(v_session.shop_id)
     and not public.has_shop_permission(v_session.shop_id, 'registers.manage') then
    raise exception 'not authorized to close another person''s register';
  end if;

  -- A currency can join the drawer mid-session: the float had none, then a sale
  -- was settled in it. Those rows are created here so the count has somewhere
  -- to land, with a zero float and today's rate at both ends.
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

  -- Expected, per currency, frozen onto the row.
  update public.register_session_cash c
     set expected_minor = e.expected_minor,
         -- A currency present on the session but absent from the count reads as
         -- counted-zero rather than as unknown: the person said what was in the
         -- drawer, and this one was not in it.
         closing_counted_minor = coalesce(c.closing_counted_minor, 0),
         closing_rate_to_usd = coalesce(c.closing_rate_to_usd, c.opening_rate_to_usd),
         variance_minor = coalesce(c.closing_counted_minor, 0) - e.expected_minor
    from public.register_session_expected(p_session_id) e
   where c.session_id = p_session_id and c.currency_code = e.currency_code;

  -- ...and only now, with every per-currency variance settled, convert and sum.
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
grant execute on function public.close_register_session(uuid, jsonb, text) to authenticated;

-- ---------------------------------------------------------------------------
-- handover_register_session
-- ---------------------------------------------------------------------------

-- One pile of money, counted once, with two people looking at it. Reassigning
-- an open session in place would leave one drawer count spanning two people, so
-- neither could be held to it -- the count IS the boundary. But making it two
-- separate flows (close, find the open sheet, re-count the same money) is the
-- kind of friction that gets skipped, so it is one act here.
--
-- One RPC rather than two client calls so a crash between them cannot leave the
-- register closed with nobody on it.
create or replace function public.handover_register_session(
  p_session_id uuid,
  p_incoming_member_id uuid,
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

  -- The counted figure becomes the incoming float, per currency, with the
  -- closing denominations carried across -- it is the same notes.
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
grant execute on function public.handover_register_session(uuid, uuid, jsonb, text) to authenticated;

-- ---------------------------------------------------------------------------
-- complete_sale, gaining p_register_session_id
--
-- Reproduced whole from 20260820000000_customer_loyalty_points.sql per the house
-- convention. Everything about stock, locations, discounts, loyalty, tax and
-- payments is carried across unmodified; the only new logic is the session
-- validation block and the extra insert column.
-- ---------------------------------------------------------------------------

drop function if exists public.complete_sale(uuid, jsonb, jsonb, text, text, text, text, integer, uuid, timestamptz, uuid, integer);

create or replace function public.complete_sale(
  p_shop_id uuid,
  p_items jsonb,
  p_payments jsonb,
  p_customer_name text default null,
  p_customer_phone text default null,
  p_customer_email text default null,
  p_cashier_name text default null,
  p_discount_cents integer default 0,
  p_customer_id uuid default null,
  p_created_at timestamptz default null,
  p_location_id uuid default null,
  p_points_redeemed integer default 0,
  p_register_session_id uuid default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_sale_id uuid;
  v_location_id uuid;
  v_item jsonb;
  v_payment jsonb;
  v_product public.products%rowtype;
  v_available integer;
  v_qty integer;
  v_line integer;
  v_line_discount integer;
  v_gross_cents integer := 0;
  v_total_cents integer := 0;
  v_item_count integer := 0;
  v_payments_total integer := 0;
  v_primary_method text;
  v_discount_cents integer := greatest(coalesce(p_discount_cents, 0), 0);
  v_tax_enabled boolean;
  v_tax_rate numeric;
  v_tax_cents integer := 0;
  v_loyalty_enabled boolean;
  v_points_per_usd numeric;
  v_cents_per_point integer;
  v_loyalty_active boolean := false;
  v_points_redeemed integer := greatest(coalesce(p_points_redeemed, 0), 0);
  v_redeem_cents integer := 0;
  v_balance integer;
  v_points_earned integer := 0;
  v_session public.register_sessions%rowtype;
begin
  if not public.has_shop_permission(p_shop_id, 'pos.access') then
    raise exception 'not authorized for shop %', p_shop_id;
  end if;
  if p_payments is null or jsonb_array_length(p_payments) = 0 then
    raise exception 'at least one payment is required';
  end if;

  if p_location_id is null then
    select l.id into v_location_id from public.shop_locations l
      where l.shop_id = p_shop_id
      order by l.is_primary desc, l.created_at asc
      limit 1;
    if v_location_id is null then
      raise exception 'shop % has no location to record this sale against', p_shop_id;
    end if;
  else
    select l.id into v_location_id from public.shop_locations l
      where l.id = p_location_id and l.shop_id = p_shop_id;
    if v_location_id is null then
      raise exception 'location % does not belong to shop %', p_location_id, p_shop_id;
    end if;
    if not public.can_access_location(v_location_id) then
      raise exception 'not authorized for location %', p_location_id;
    end if;
  end if;

  -- The session, when the client sent one. Validated rather than trusted: a
  -- sale filed against a closed session would land in a drawer count somebody
  -- has already signed off, and one filed against another branch's session
  -- would put the money in the wrong till.
  if p_register_session_id is not null then
    select * into v_session from public.register_sessions where id = p_register_session_id;
    if v_session.id is null then
      raise exception 'register session % not found', p_register_session_id;
    end if;
    if v_session.shop_id <> p_shop_id then
      raise exception 'register session % does not belong to shop %', p_register_session_id, p_shop_id;
    end if;
    if v_session.location_id <> v_location_id then
      raise exception 'register session % is at a different location than this sale', p_register_session_id;
    end if;
    if v_session.closed_at is not null then
      raise exception 'register session % is already closed', p_register_session_id;
    end if;
  end if;

  -- A branch that requires an open register means it: without this the setting
  -- is advisory, and the client is the party it is meant to constrain. Read off
  -- the resolved location, so turning it on at one branch never stops another
  -- selling.
  if p_register_session_id is null
     and (select require_open_register from public.shop_locations where id = v_location_id) then
    raise exception 'this store requires an open register before a sale can be rung up';
  end if;

  v_primary_method := p_payments->0->>'method';
  if v_primary_method not in ('cash','zaad','edahab','other') then
    raise exception 'invalid payment method %', v_primary_method;
  end if;

  select tax_enabled, tax_rate_percent,
         loyalty_enabled, loyalty_points_per_usd, loyalty_cents_per_point
    into v_tax_enabled, v_tax_rate,
         v_loyalty_enabled, v_points_per_usd, v_cents_per_point
    from public.shops where id = p_shop_id;

  -- The module check is not belt and braces. public.customers and
  -- customer_points_ledger both carry enforce_shop_module('customers') as a
  -- BEFORE trigger, and security definer does not bypass a trigger -- so
  -- touching either on a lapsed shop would raise module_not_included and refuse
  -- the whole sale. A shop that stops paying must still be able to sell.
  v_loyalty_active := coalesce(v_loyalty_enabled, false)
    and p_customer_id is not null
    and public.shop_has_module(p_shop_id, 'customers');

  if v_points_redeemed > 0 and not v_loyalty_active then
    raise exception 'loyalty points cannot be redeemed on this sale';
  end if;

  insert into public.sales (shop_id, location_id, created_by, payment_method, customer_name, customer_phone, customer_email, cashier_name, discount_cents, customer_id, created_at, register_session_id)
    values (p_shop_id, v_location_id, auth.uid(), v_primary_method, nullif(p_customer_name, ''), nullif(p_customer_phone, ''), nullif(p_customer_email, ''), nullif(p_cashier_name, ''), v_discount_cents, p_customer_id, coalesce(p_created_at, now()), p_register_session_id)
    returning id into v_sale_id;

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_qty := (v_item->>'quantity')::integer;
    if v_qty is null or v_qty <= 0 then
      raise exception 'invalid quantity in cart item';
    end if;

    select * into v_product from public.products
      where id = (v_item->>'product_id')::uuid and shop_id = p_shop_id;

    if v_product.id is null then
      raise exception 'product % not found in this shop', v_item->>'product_id';
    end if;

    select stock into v_available from public.product_location_stock
      where product_id = v_product.id and location_id = v_location_id
      for update;

    if coalesce(v_available, 0) < v_qty then
      raise exception 'insufficient stock for % at this location: has %, need %',
        v_product.name, coalesce(v_available, 0), v_qty;
    end if;

    v_line_discount := greatest(coalesce((v_item->>'discount_cents')::integer, 0), 0);
    v_line := v_product.price_cents * v_qty - v_line_discount;
    if v_line < 0 then
      raise exception 'discount exceeds line total for %', v_product.name;
    end if;

    update public.product_location_stock set stock = stock - v_qty, updated_at = now()
      where product_id = v_product.id and location_id = v_location_id;

    insert into public.sale_items (sale_id, product_id, product_name, unit_price_cents, quantity, line_total_cents, discount_cents, unit_cost_cents)
      values (v_sale_id, v_product.id, v_product.name, v_product.price_cents, v_qty, v_line, v_line_discount, v_product.cost_cents);

    v_gross_cents := v_gross_cents + v_line;
    v_item_count := v_item_count + v_qty;
  end loop;

  if v_item_count = 0 then
    raise exception 'cannot complete a sale with no items';
  end if;

  v_total_cents := v_gross_cents - v_discount_cents;
  if v_total_cents < 0 then
    raise exception 'discount exceeds sale total';
  end if;

  if v_points_redeemed > 0 then
    -- The lock that makes the balance check atomic across two registers. Taken
    -- on the counter rather than by summing the ledger, for the reason
    -- shop_usage_counters gives: a sum is neither O(1) nor safe under
    -- concurrency -- both tills read the same balance and both pass.
    select points_balance into v_balance from public.customers
      where id = p_customer_id and shop_id = p_shop_id
      for update;
    if v_balance is null then
      raise exception 'customer % not found in this shop', p_customer_id;
    end if;
    if v_points_redeemed > v_balance then
      raise exception 'customer has % points, cannot redeem %', v_balance, v_points_redeemed;
    end if;

    v_redeem_cents := v_points_redeemed * v_cents_per_point;

    -- Raise rather than clamp. The client has already collected payment against
    -- a total computed with this redemption, so quietly spending fewer points
    -- would leave the payments short and fail the equality check below with a
    -- message that names neither the cause nor the fix.
    if v_redeem_cents > v_total_cents then
      raise exception 'redeeming % points is worth % cents, more than the % cents owed',
        v_points_redeemed, v_redeem_cents, v_total_cents;
    end if;

    v_total_cents := v_total_cents - v_redeem_cents;
  end if;

  -- Earned on merchandise actually paid for in money: after every discount
  -- including the redemption, and before tax. Rounded to the nearest whole
  -- point, so $19.99 earns 20.
  if v_loyalty_active then
    v_points_earned := round(v_total_cents * v_points_per_usd / 100)::integer;
  end if;

  if v_tax_enabled then
    v_tax_cents := round(v_total_cents * v_tax_rate / 100)::integer;
  end if;
  v_total_cents := v_total_cents + v_tax_cents;

  for v_payment in select * from jsonb_array_elements(p_payments) loop
    if (v_payment->>'method') not in ('cash','zaad','edahab','other') then
      raise exception 'invalid payment method %', v_payment->>'method';
    end if;
    if (v_payment->>'amount_cents')::integer <= 0 then
      raise exception 'payment amount must be greater than zero';
    end if;
    v_payments_total := v_payments_total + (v_payment->>'amount_cents')::integer;

    insert into public.sale_payments (sale_id, method, amount_cents, tendered_cents, customer_name, customer_phone, currency_code, exchange_rate, foreign_amount_cents, foreign_change_cents)
      values (
        v_sale_id,
        v_payment->>'method',
        (v_payment->>'amount_cents')::integer,
        (v_payment->>'tendered_cents')::integer,
        v_payment->>'customer_name',
        v_payment->>'customer_phone',
        nullif(v_payment->>'currency_code', ''),
        (v_payment->>'exchange_rate')::numeric,
        (v_payment->>'foreign_amount_cents')::integer,
        (v_payment->>'foreign_change_cents')::integer
      );
  end loop;

  if v_payments_total <> v_total_cents then
    raise exception 'payments total % does not match sale total %', v_payments_total, v_total_cents;
  end if;

  update public.sales set
    total_cents = v_total_cents,
    item_count = v_item_count,
    tax_cents = v_tax_cents,
    tax_rate_percent = case when v_tax_enabled then v_tax_rate else null end,
    points_redeemed = v_points_redeemed,
    points_redeemed_cents = v_redeem_cents,
    points_earned = v_points_earned,
    loyalty_points_per_usd = case when v_loyalty_active then v_points_per_usd else null end
  where id = v_sale_id;

  -- Two rows, never one net row. "Spent 200, earned 3" is what a customer
  -- querying their balance needs to see; a net -197 hides both facts and
  -- answers no question anyone actually asks.
  --
  -- Written after the payments check, so a sale that gets refused moves no
  -- points.
  if v_points_redeemed > 0 then
    insert into public.customer_points_ledger
      (shop_id, customer_id, sale_id, delta_points, reason, cents_per_point, created_by)
      values (p_shop_id, p_customer_id, v_sale_id, -v_points_redeemed, 'redeem',
              v_cents_per_point, auth.uid());
  end if;
  if v_points_earned > 0 then
    insert into public.customer_points_ledger
      (shop_id, customer_id, sale_id, delta_points, reason, points_per_usd, created_by)
      values (p_shop_id, p_customer_id, v_sale_id, v_points_earned, 'earn',
              v_points_per_usd, auth.uid());
  end if;

  return v_sale_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Permission catalogue and the Manager role
-- ---------------------------------------------------------------------------

-- One new permission, not three. Opening and closing YOUR OWN register is
-- inseparable from using the POS, so it rides on pos.access. Creating and
-- renaming registers is a Settings act, so it rides on settings.access -- the
-- same bar CashiersPanel sits behind. What genuinely needs its own gate is
-- acting on someone else's money: assigning another employee to a register and
-- signing off their variance.
--
-- Guarded so re-running is a no-op and a customised role is not overwritten --
-- the same shape 20260804000500 used for budgets.manage.
update public.roles
  set permissions = permissions || array['registers.manage']
  where name = 'Manager'
    and permissions @> array['sales.edit', 'dashboard.view']
    and not permissions && array['registers.manage'];
