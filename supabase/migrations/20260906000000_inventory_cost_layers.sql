-- What each delivery cost, remembered per delivery instead of per product.
--
-- ## What one cost_cents cannot answer
--
-- products.cost_cents holds a single figure that receive_stock overwrites every
-- time stock arrives. That is a weighted average, and it is a legitimate basis
-- -- but it cannot say what THESE units cost. Buy 200 bags of rice at 14.10 and
-- 180 at 14.50, sell 300, and the column has no way to report that the first
-- 200 left at the old price. So FIFO is impossible, and the stock figure on a
-- balance sheet drifts from what the shop actually paid.
--
-- A layer is one delivery. It knows what it cost, how many arrived and how many
-- are left, and it is never overwritten -- it is drawn down until it is empty
-- and then it stays as history.
--
-- ## Why per location and not per shop
--
-- Kaiibi already tracks stock per location and reports profit per location. A
-- shop-wide pool would let a sale at one branch consume a delivery physically
-- sitting at another, which makes each branch's cost of sales fiction.
--
-- The cost of that correctness is real and is paid in 20260906000500: a
-- transfer has to move layer quantity CARRYING its cost, or moving stock
-- between your own branches silently reprices it.
--
-- ## What this migration does NOT do
--
-- Nothing writes to these tables yet. The functions come next
-- (20260906000100), the five RPCs after that, and the opening layers for
-- existing stock last. Until then both tables are empty and no behaviour
-- changes -- which is deliberate, so each step can be judged on its own.

create table public.inventory_cost_layers (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  -- No ON DELETE: a location that holds cost history must not be deletable,
  -- and the reference is what enforces it. The same choice stock_receipts,
  -- stock_transfers and stock_counts all make -- a branch is deactivated,
  -- never deleted, once it has traded.
  location_id uuid not null references public.shop_locations(id),
  -- Null where the product is uncosted. NEVER zero: zero is a real answer
  -- meaning the unit was free, and product-costing.ts is careful about the
  -- difference. A layer that forced zero would report the units as costless and
  -- overstate gross profit by their whole value.
  unit_cost_cents integer check (unit_cost_cents is null or unit_cost_cents >= 0),
  -- Zero received is refused: a layer for nothing is a bug in the caller, not a
  -- no-op worth storing.
  quantity_received integer not null check (quantity_received > 0),
  quantity_remaining integer not null check (quantity_remaining >= 0),
  source text not null check (source in ('receipt','opening','count','return','transfer','provisional')),
  -- The receipt, count or transfer behind it. Null for an opening layer, which
  -- has no document -- it is the migration's statement of what was on the shelf
  -- the day layers began.
  source_id uuid,
  -- Neither column is read by any accounting, and both are here on purpose.
  --
  -- products.expiry_date has exactly the defect cost_cents has: one value per
  -- product, overwritten by the next delivery. Two batches of milk with
  -- different dates cannot both be represented, so the second silently replaces
  -- the first and getExpiringProducts() warns on the wrong day. A layer IS a
  -- delivery, so it is the right home for both -- and populating them now means
  -- the fix later needs no second pass over complete_sale.
  --
  -- getExpiringProducts() is unchanged and still reads the product column.
  -- Moving it is a separate piece of work these columns make cheap.
  expires_on date,
  batch_number text,
  -- Created by a sale that outran the stock record -- the shelf had units the
  -- app did not know about. Trued up when stock next arrives; until then the
  -- value it carries is a guess, and any valuation report has to be able to say
  -- how much of its total is guessed.
  is_provisional boolean not null default false,
  received_at timestamptz not null default now(),
  constraint layer_not_over_consumed check (quantity_remaining <= quantity_received)
);

-- Every consumption is this lookup. The partial predicate keeps exhausted
-- layers out of the index on a table that only ever grows -- a shop three years
-- in has far more spent layers than open ones, and they are never searched.
--
-- received_at AND id, and the id is not decorative. received_at alone is not a
-- total order: one receive_stock call writing two lines for the same product
-- produces two layers with equal timestamps. Two sessions sorting those
-- differently take the same locks in different orders, which is a deadlock --
-- the same reasoning receive_stock:131 gives for adding ordinality behind
-- product id. Every caller must use this exact ordering.
create index inventory_cost_layers_open_idx
  on public.inventory_cost_layers (shop_id, product_id, location_id, received_at, id)
  where quantity_remaining > 0;

-- Which layers a sale line drew from, and at what price.
--
-- Needed for three things that are otherwise unanswerable: a refund putting
-- units back at the price they left at, sale_items.unit_cost_cents being
-- explainable after the fact when a line spanned two layers, and the posting
-- phase writing a COGS figure it can defend.
create table public.inventory_cost_consumption (
  id uuid primary key default gen_random_uuid(),
  sale_item_id uuid not null references public.sale_items(id) on delete cascade,
  -- No ON DELETE: a layer that has been consumed must not be deletable, and the
  -- reference is what enforces it.
  layer_id uuid not null references public.inventory_cost_layers(id),
  quantity integer not null check (quantity > 0),
  -- The LAYER's cost, unrounded. sale_items.unit_cost_cents carries the rounded
  -- blend; these rows carry the truth, so the two together always reconcile to
  -- the exact cost of the line.
  unit_cost_cents integer check (unit_cost_cents is null or unit_cost_cents >= 0)
);
create index inventory_cost_consumption_sale_item_idx on public.inventory_cost_consumption(sale_item_id);
create index inventory_cost_consumption_layer_idx on public.inventory_cost_consumption(layer_id);

alter table public.inventory_cost_layers enable row level security;
alter table public.inventory_cost_consumption enable row level security;

create policy "read inventory_cost_layers" on public.inventory_cost_layers for select
  using (has_shop_permission(shop_id, 'inventory.view'));
create policy "read inventory_cost_consumption" on public.inventory_cost_consumption for select
  using (exists (
    select 1 from public.inventory_cost_layers l
     where l.id = layer_id and has_shop_permission(l.shop_id, 'inventory.view')
  ));

-- No insert/update/delete policy, on purpose and for the same reason
-- stock_receipts, stock_counts, stock_transfers and the ledger tables have
-- none: a layer is only ever written by the security definer functions that
-- change the stock count in the same transaction. A direct write would move
-- cost without moving units, and nothing would report the two had parted ways.
grant select on public.inventory_cost_layers, public.inventory_cost_consumption to authenticated;
