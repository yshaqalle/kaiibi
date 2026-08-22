-- A stock-take.
--
-- The fourth stock job, and the sharp one. The other three are recoverable:
-- Restock adds units against an invoice, Move relocates them and leaves the
-- shop total alone, Import creates catalogue rows. Count DESTROYS units against
-- nothing, and there is no counterparty and no paperwork -- a Restock
-- overstating by 40 is caught by the supplier's invoice, while a Count writing
-- 11 down to 8 is one person's word that three units are not there.
--
-- ## Why this is not receive_stock with a minus sign
--
-- receive_stock ADDS: `stock = stock + excluded.stock`. This one SETS:
-- `stock = excluded.stock`. That single line is the entire difference between
-- the two doors and the reason both exist -- a shop that walks a shelf knows
-- how many are on it, not how many have gone missing since Tuesday, and asking
-- them to subtract is asking them to do the arithmetic the app is for. The
-- variance is computed here, from what the shop holds at the moment of the
-- count, and recorded.
--
-- ## Why the shrinkage was invisible before this table existed
--
-- COGS is built from sale_items.unit_cost_cents, frozen at sale time. A unit
-- that is stolen, breaks or expires is NEVER SOLD, so its cost never enters
-- COGS by any path. It leaves Stock at cost and is simply gone, and the P&L
-- never hears about it -- gross profit reads higher than it is by exactly the
-- cost of everything that walked out, every month, invisibly. Per-product stock
-- could already be edited inline on the Inventory list, which is a count one
-- product at a time with no reason, no record and no P&L effect, so this has
-- been true for as long as the app has had stock. stock_count_items therefore
-- freezes unit_cost_cents alongside the variance: the value of what went
-- missing has to be answerable later, from the record, and not recomputed from
-- a cost some later delivery has since overwritten.
--
-- Modelled on receive_stock() deliberately, down to the lock ordering, because
-- the two are the same shape: change counts and write a record, in one
-- transaction, through a security definer function with no write policy behind
-- it. The differences are stated where they occur.

create table public.stock_counts (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  -- NO ACTION, not cascade -- the default, and the same choice stock_receipts
  -- and stock_transfers make. Deleting a location must not erase the history of
  -- what was counted there; a branch is deactivated, never deleted, once it has
  -- traded.
  location_id uuid not null references public.shop_locations(id),
  -- One free-text note for the whole count ("monday shelf walk", "after the
  -- flood"). The REASONS are per line and live on the items below: one
  -- stock-take finds different causes on different shelves -- sun cream
  -- expired, toner walked -- and a single reason across the whole count would
  -- be wrong on almost every line it covered.
  note text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);
create index stock_counts_shop_idx on public.stock_counts(shop_id, created_at desc);
create index stock_counts_location_idx on public.stock_counts(location_id, created_at desc);

create table public.stock_count_items (
  id uuid primary key default gen_random_uuid(),
  count_id uuid not null references public.stock_counts(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  -- Frozen at count time, exactly as stock_receipt_items and sale_items freeze
  -- it: a later rename must not restate what a past stock-take found.
  product_name text not null,
  -- What the app believed, read under a row lock immediately before it was
  -- replaced. Recorded because "who said these three were gone, and when?" is
  -- the whole reason to build this door rather than keep editing counts inline,
  -- and that question cannot be answered from the new number alone.
  previous_quantity integer not null,
  -- Zero is allowed and negative is not. An empty shelf is a real finding and
  -- one of the most important a stock-take makes; minus three units is not a
  -- quantity anybody counted.
  counted_quantity integer not null check (counted_quantity >= 0),
  -- Generated rather than passed in, so the record and the arithmetic cannot
  -- disagree. A client that computed this itself would be a second opinion on a
  -- subtraction, and the two would eventually differ on some row nobody looks at.
  variance integer generated always as (counted_quantity - previous_quantity) stored,
  -- Optional, and a closed set. Optional because requiring a reason on every
  -- one of sixteen variances is how a 300-line stock-take stops getting done,
  -- or gets done with sixteen 'miscount's that mean nothing -- so a blank is
  -- allowed and the preview says "9 with no reason" out loud instead, because
  -- unexplained shrinkage is itself the finding. Closed because the preview
  -- COUNTS them, and a sixth spelling would quietly become a sixth category.
  reason text check (reason is null or reason in ('damaged', 'expired', 'theft_or_loss', 'miscount', 'other')),
  -- What a unit cost at the moment of the count, frozen. Null where the product
  -- is uncosted -- null, never zero, because zero is a real answer (a free
  -- sample) and isUncosted() in product-costing.ts is careful about exactly
  -- this. Without the freeze, valuing a count from six months ago would use
  -- whatever cost the most recent delivery happened to leave behind.
  unit_cost_cents integer check (unit_cost_cents is null or unit_cost_cents >= 0)
);
create index stock_count_items_count_idx on public.stock_count_items(count_id);
-- "What has this product been counted at, and how often did it come up short?"
-- is the question a shrinkage report asks, and it asks it per product.
create index stock_count_items_product_idx on public.stock_count_items(product_id);

alter table public.stock_counts enable row level security;
alter table public.stock_count_items enable row level security;

create policy "read stock_counts" on public.stock_counts for select using (is_shop_member(shop_id));
create policy "read stock_count_items" on public.stock_count_items for select
  using (exists (select 1 from public.stock_counts c where c.id = count_id and is_shop_member(c.shop_id)));

-- No insert/update/delete policy, on purpose and for the same reason as
-- stock_receipts and stock_transfers: a count is only ever created through
-- save_stock_count() below, which changes the numbers and writes the record in
-- one transaction. A direct insert would record a stock-take that never
-- happened -- and here that is worse than elsewhere, because the record IS the
-- accountability the door exists to provide.
grant select on public.stock_counts, public.stock_count_items to authenticated;

-- Gated on `inventory`, NOT on `multi_location`.
--
-- stock_transfers is gated on multi_location because a movement needs two
-- branches to exist at all. A stock-take needs one. Copying that trigger across
-- would lock every single-store shop out of the door -- and a single-store shop
-- is the most common shop on the platform and the one with nobody else to check
-- its shelves. stock_receipts already makes this same divergence for the same
-- reason; this is not a new judgement, it is the same one.
create trigger stock_counts_module before insert or update on public.stock_counts
  for each row execute function public.enforce_shop_module('inventory');

-- Replaces the count at one store with what was actually found, records the
-- variance and why, and leaves every product it was not given alone.
--
-- ## Why the permission is checked here and not only on the sheet
--
-- 'inventory.count', not 'inventory.edit'. Every other stock RPC checks the
-- broader permission because receiving and moving are recoverable; this one
-- destroys value against no counterparty, so the narrow one is the whole point
-- of it existing. Checking it in the client alone would make the sheet the only
-- thing standing between a cashier and a write-off, and the sheet is JavaScript
-- on a device the shop does not control.
--
-- ## What this deliberately does NOT do
--
-- It does not touch a product it was not given. A stock-take of one shelf
-- leaves the other two hundred products exactly as they were, and there is no
-- mode in which a count is "authoritative for the store". The alternative --
-- zeroing anything absent -- is a foot-gun that turns one afternoon on aisle
-- three into a wiped inventory, and it is not built, not flagged, and not
-- reachable.
create or replace function public.save_stock_count(
  p_shop_id uuid,
  p_location_id uuid,
  p_items jsonb,
  p_note text default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_count_id uuid;
  v_item jsonb;
  v_product public.products%rowtype;
  v_counted integer;
  v_previous integer;
  v_reason text;
  v_lines integer := 0;
begin
  -- Before anything is inserted, so a refusal leaves no half-written
  -- stock-take on record.
  if not public.has_shop_permission(p_shop_id, 'inventory.count') then
    raise exception 'not authorized for shop %', p_shop_id;
  end if;
  if not exists (select 1 from public.shop_locations where id = p_location_id and shop_id = p_shop_id) then
    raise exception 'the counted location must belong to shop %', p_shop_id;
  end if;
  if p_items is null or jsonb_array_length(p_items) = 0 then
    raise exception 'a count must include at least one line';
  end if;

  insert into public.stock_counts (shop_id, location_id, note, created_by)
    values (p_shop_id, p_location_id, nullif(p_note, ''), auth.uid())
    returning id into v_count_id;

  -- Ordered by product id so two concurrent counts touching the same products
  -- take their row locks in the same order and cannot deadlock -- the same
  -- reason receive_stock, transfer_stock and refund_sale_items order their
  -- loops. Ordinality is the tiebreaker: product id alone is not a total order
  -- when a sheet lists the same product twice, and without one the surviving
  -- count would be whichever line happened to sort second. With it, the last
  -- line in the sheet is the one that stands, which is the only reading a
  -- person can predict from what they are looking at.
  for v_item in
    select value from jsonb_array_elements(p_items) with ordinality as t(value, ord)
      order by (value->>'product_id'), ord
  loop
    v_counted := (v_item->>'counted_quantity')::integer;
    -- Zero passes. It is the finding a stock-take most often exists to make.
    if v_counted is null or v_counted < 0 then
      raise exception 'invalid counted quantity';
    end if;

    select * into v_product from public.products
      where id = (v_item->>'product_id')::uuid and shop_id = p_shop_id;
    if v_product.id is null then
      raise exception 'product % not found in this shop', v_item->>'product_id';
    end if;

    -- Read under a row lock and immediately replaced, so the number recorded as
    -- "what the app said" is the number this statement actually overwrote. A
    -- sale completing between the read and the write would otherwise be
    -- silently absorbed into the variance and attributed to shrinkage.
    --
    -- Null means the store has no row for this product at all -- it does not
    -- carry it. That is a legitimate thing to find three of on a shelf, so it
    -- counts as a previous of zero and the upsert creates the row.
    select stock into v_previous from public.product_location_stock
      where product_id = v_product.id and location_id = p_location_id
      for update;
    v_previous := coalesce(v_previous, 0);

    -- `= excluded.stock`, not `+`. THE line that makes this a Count.
    insert into public.product_location_stock (product_id, location_id, stock)
      values (v_product.id, p_location_id, v_counted)
      on conflict (product_id, location_id)
      do update set stock = excluded.stock, updated_at = now();

    -- nullif('') as well as a plain null: a client that sends an empty string
    -- for "no reason given" must not trip the check constraint, and an empty
    -- string is not a sixth reason.
    v_reason := nullif(v_item->>'reason', '');

    insert into public.stock_count_items
      (count_id, product_id, product_name, previous_quantity, counted_quantity, reason, unit_cost_cents)
      values (v_count_id, v_product.id, v_product.name, v_previous, v_counted, v_reason, v_product.cost_cents);

    v_lines := v_lines + 1;
  end loop;

  -- Unreachable, and kept anyway: jsonb_array_length above has already refused
  -- an empty array, and every element either records a line or raises. Mirrors
  -- receive_stock line for line so the two RPCs can be read side by side, and
  -- it is the backstop if either guard is ever loosened.
  if v_lines = 0 then
    raise exception 'cannot record a count with no lines';
  end if;
  return v_count_id;
end;
$$;

grant execute on function public.save_stock_count(uuid, uuid, jsonb, text) to authenticated;
