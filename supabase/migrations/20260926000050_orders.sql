-- orders and order_items: what a stranger's cart becomes once they check out.
--
-- No account, no auth.users reference. The phone number IS the identity --
-- there is nothing else to key an anonymous customer on, and Task 2's insert
-- path runs as `anon`.
--
-- SNAPSHOTS, same reasoning as sale_items (0001_init.sql:60-68) and
-- storefronts.payment_mode (20260924000000_storefront.sql): every money
-- column, the delivery area's name, and payment_mode are copied at order
-- time and never joined live. A shop re-pricing a delivery area, renaming
-- it, or (eventually) turning on online payment must not rewrite what an
-- earlier customer already agreed to. order_items mirrors sale_items
-- exactly for the same reason a sale line does: `product_id ... on delete
-- set null` plus product_name/unit_price_cents/quantity/line_total_cents,
-- so a line still says what was ordered and at what price after the
-- product itself is gone.
--
-- ── The order number ─────────────────────────────────────────────────────
--
-- Per-shop, sequential, short enough to say on the phone -- not a UUID.
-- Three ways to get there, and why the third one is this migration:
--
--   * `count(*) + 1` at insert time. Races under concurrent inserts: two
--     customers checking out from the same shop in the same moment both
--     read the same count and both mint the same number. This is the exact
--     bug 20260908000150_journal_entry_sequence.sql already found and fixed
--     for journal references -- re-deriving it here would be reintroducing
--     a known, already-diagnosed race.
--   * A plain Postgres SEQUENCE (the pattern support_threads uses for
--     KB-2001, KB-2002...). Race-free, but shared: shop A's numbers would
--     jump by however many orders shop B placed in between, leaking one
--     tenant's order volume to another through gaps a shopkeeper can see
--     with their own eyes. It also leaves permanent gaps on a rolled-back
--     insert.
--   * A per-shop counter row, taken with one
--     `INSERT ... ON CONFLICT DO UPDATE ... RETURNING`. That statement
--     takes a row lock on the shop's own counter, so a concurrent insert for
--     the SAME shop blocks and re-reads rather than racing; a concurrent
--     insert for a DIFFERENT shop touches a different row and is untouched.
--     One number to one caller, no cross-tenant leakage, gapless within a
--     shop. This is `order_number_counters`, and the mechanism is
--     `journal_entry_sequences`'s, applied per-shop instead of per-shop-per-
--     year.
--
-- It runs as a BEFORE INSERT TRIGGER rather than inline in an RPC (which is
-- how post_journal_entry does its own numbering) because Task 1 has no RPC
-- yet -- `orders` gets its first rows through a plain RLS insert -- and Task
-- 2's `place_storefront_order` is `security definer`, which bypasses RLS and
-- any policy but never a trigger. One trigger covers both callers, present
-- and future, for free, and cannot be forgotten when the RPC is added
-- (20260818000400_module_write_gates.sql's header makes the same argument
-- for module gates, reason 1).
--
-- The counter table itself carries no grant to anon or authenticated and no
-- RLS policy -- only the security-definer trigger touches it, the same
-- posture journal_entry_sequences takes and for the same reason: a caller
-- who could bump it by hand could burn or collide a number.
create table public.order_number_counters (
  shop_id     uuid primary key references public.shops(id) on delete cascade,
  next_number integer not null default 1
);

alter table public.order_number_counters enable row level security;
revoke all on public.order_number_counters from anon, authenticated;

create table public.orders (
  id       uuid primary key default gen_random_uuid(),
  shop_id  uuid not null references public.shops(id) on delete cascade,

  -- Assigned by the orders_assign_number trigger below, always -- whatever a
  -- caller supplies here is overwritten before the row lands.
  number integer not null,

  customer_name  text not null,
  -- Same pattern as shops_whatsapp_is_e164 (20260924000000_storefront.sql).
  customer_phone text not null check (customer_phone ~ '^\+[1-9][0-9]{7,14}$'),

  fulfilment text not null check (fulfilment in ('collect', 'deliver')),

  -- Snapshots of the chosen storefront_delivery_areas row -- name, never an
  -- id, so the area being renamed or deleted later cannot rewrite an
  -- existing order's paperwork. Null for collect; required for deliver.
  delivery_area     text,
  delivery_landmark text,

  note text,

  -- Copied by the orders_copy_payment_mode trigger below from this shop's
  -- storefronts.payment_mode at insert -- never accepted from the caller.
  -- CHECK-constrained to the same single value storefronts.payment_mode
  -- permits today (20260924000000_storefront.sql). These two CHECKs are a
  -- hand-synced pair on purpose, not a shared function: storefronts.
  -- payment_mode's own CHECK is a plain literal, not a function, and this
  -- one mirrors it exactly so the two stay legible side by side. If that
  -- CHECK ever grows a second value (online payment), this one must grow
  -- with it in the same migration.
  payment_mode text not null check (payment_mode in ('on_collection')),

  -- Plan 4 owns the transitions between these; this migration only commits
  -- to the vocabulary and the starting point. Adding a status later is an
  -- additive CHECK change, same as storefronts.payment_mode's own comment
  -- describes for 'online'.
  status text not null default 'pending'
    check (status in ('pending', 'accepted', 'ready', 'completed', 'cancelled')),

  subtotal_cents      integer not null check (subtotal_cents >= 0),
  delivery_fee_cents  integer not null default 0 check (delivery_fee_cents >= 0),
  total_cents         integer not null check (total_cents >= 0),

  created_at timestamptz not null default now(),

  -- Belt and braces behind the trigger: the trigger is what makes a
  -- collision practically impossible, this is what makes it structurally
  -- impossible.
  unique (shop_id, number),

  -- A collect order carries no delivery area and no delivery fee; a deliver
  -- order must name an area. Catches a checkout bug that charges delivery on
  -- a pickup, or accepts "deliver" with nowhere to deliver to.
  constraint orders_delivery_matches_fulfilment check (
    (fulfilment = 'collect' and delivery_area is null and delivery_fee_cents = 0)
    or
    (fulfilment = 'deliver' and delivery_area is not null)
  ),

  -- The two snapshot amounts must add up to the third. Catches a checkout
  -- that recomputes one figure and forgets the other.
  constraint orders_total_is_subtotal_plus_delivery
    check (total_cents = subtotal_cents + delivery_fee_cents)
);
create index orders_shop_id_idx on public.orders(shop_id);

create table public.order_items (
  id               uuid primary key default gen_random_uuid(),
  order_id         uuid not null references public.orders(id) on delete cascade,
  product_id       uuid references public.products(id) on delete set null,
  product_name     text not null,
  unit_price_cents integer not null,
  quantity         integer not null check (quantity > 0),
  line_total_cents integer not null
);
create index order_items_order_id_idx on public.order_items(order_id);

alter table public.orders enable row level security;
alter table public.order_items enable row level security;

create policy "own orders" on public.orders for all
  using (public.is_shop_member(shop_id)) with check (public.is_shop_member(shop_id));

create policy "own order_items" on public.order_items for all
  using (exists (select 1 from public.orders o where o.id = order_id and public.is_shop_member(o.shop_id)));

-- ── Number assignment ───────────────────────────────────────────────────
create or replace function public.assign_order_number()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_number integer;
begin
  -- next_number - 1 because the row is left holding the number the NEXT
  -- caller gets: the insert path stores 2 and returns 1, the update path
  -- stores N+1 and returns N. Same arithmetic as journal_entry_sequences.
  insert into public.order_number_counters (shop_id, next_number)
    values (new.shop_id, 2)
  on conflict (shop_id) do update
    set next_number = public.order_number_counters.next_number + 1
  returning next_number - 1 into v_number;

  new.number := v_number;
  return new;
end;
$$;

create trigger orders_assign_number
  before insert on public.orders
  for each row execute function public.assign_order_number();

-- ── payment_mode copy ───────────────────────────────────────────────────
create or replace function public.copy_storefront_payment_mode()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_payment_mode text;
begin
  select payment_mode into v_payment_mode
    from public.storefronts where shop_id = new.shop_id;

  if v_payment_mode is null then
    raise exception 'shop % has no storefront to take an order''s payment_mode from', new.shop_id;
  end if;

  new.payment_mode := v_payment_mode;
  return new;
end;
$$;

create trigger orders_copy_payment_mode
  before insert on public.orders
  for each row execute function public.copy_storefront_payment_mode();

-- ── Module gate ─────────────────────────────────────────────────────────
-- orders is a storefront-module table like storefronts and
-- storefront_delivery_areas (20260924000000_storefront.sql's
-- storefronts_module_gate / delivery_areas_module_gate), gated the same way
-- those are -- a trigger, never a policy, per
-- 20260818000400_module_write_gates.sql's header. That reasoning applies
-- doubly here: Task 2's place_storefront_order is security definer and will
-- re-check "published and entitled" itself, but a trigger is the only thing
-- that also covers the plain RLS insert path this migration adds for shop
-- members, and it cannot be skipped by a future RPC that forgets to.
--
-- order_items gets no trigger of its own -- gating orders alone covers the
-- whole checkout, the same reasoning sales_module's comment gives for why
-- sale_items carries none.
create trigger orders_module
  before insert or update on public.orders
  for each row execute function public.enforce_shop_module('storefront');

-- ── Grants ──────────────────────────────────────────────────────────────
-- Explicit and required -- RLS narrows what a role may see, it does not
-- grant the role reach in the first place, and this repo has no
-- `alter default privileges` (20260925000100_storefront_table_grants.sql).
-- anon gets nothing here, deliberately: Task 2's place_storefront_order is
-- the only anonymous path onto these tables.
grant select, insert, update, delete on public.orders to authenticated;
grant select, insert, update, delete on public.order_items to authenticated;
