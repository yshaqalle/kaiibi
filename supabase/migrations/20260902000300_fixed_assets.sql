-- Things the shop bought that it still owns: the display fridge, the delivery
-- bike, the till itself.
--
-- Why this is not an expense. A $3,000 fridge bought in March is not a $3,000
-- March cost -- it is five years of cooling, and charging the whole thing to
-- one month makes March look disastrous and the next fifty-nine months look
-- better than they were. Splitting it is depreciation, and without a place to
-- record the asset there is nothing to split.
--
-- Two decisions:
--
--   **Straight line, and only straight line.** Cost less salvage, spread
--   evenly over the asset's life. Reducing-balance and units-of-production are
--   real methods that a shop of this size does not use, and each extra method
--   is another set of figures nobody can check by hand.
--
--   **Depreciation is computed, never posted.** There is no monthly job
--   writing entries, and no `accumulated_depreciation_cents` column. An
--   asset's depreciation at any date is a function of its cost, its life and
--   the date -- see src/lib/fixed-assets.ts, where it is pure and unit-tested.
--   A missed month cannot leave the books wrong, because there is no month to
--   miss, and a stored figure that disagrees with the formula cannot exist.
--
-- This table is what the `fixed_assets`, `accumulated_depreciation`,
-- `expense_depreciation` and `asset_disposal_result` feeds report. As with
-- every feed, nothing is posted for it -- see the chart-of-accounts migration.
--
-- The one surprise, stated because a reader will hit it: an asset ALSO logged
-- as an `inventory_purchase` expense is counted twice, once here and once
-- there. The asset editor says so where someone can act on it.

create table public.fixed_assets (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  -- Which store it sits in. NULL = business-wide, matching the rest of
  -- Accounting (20260816000000) -- a van serving three shops belongs to none
  -- of them.
  location_id uuid references public.shop_locations(id) on delete set null,
  name text not null,
  category text not null default 'equipment' check (category in (
    'equipment','furniture','fittings','vehicle','technology','building','other'
  )),
  acquired_on date not null default current_date,
  cost_cents integer not null check (cost_cents > 0),
  -- What it will be worth when the shop is done with it. Almost always zero
  -- for a till or a laptop, rarely zero for a vehicle, and the difference is
  -- what keeps a van from depreciating to nothing while still being driven.
  salvage_value_cents integer not null default 0 check (salvage_value_cents >= 0),
  -- Months rather than years: a two-and-a-half-year lease on a shop fitting is
  -- a real figure an owner knows, and 2.5 is not a thing to store as a float.
  useful_life_months integer not null check (useful_life_months > 0),
  vendor_id uuid references public.vendors(id) on delete set null,
  reference text,
  notes text,
  -- Sold, scrapped or written off. Depreciation stops on this date, and the
  -- difference between what it fetched and what it was still worth on the
  -- books becomes the period's gain or loss -- reported through the
  -- `asset_disposal_result` feed, not posted.
  disposed_on date,
  disposal_proceeds_cents integer check (disposal_proceeds_cents >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id),
  updated_by uuid references auth.users(id),
  -- An asset cannot depreciate below what it will eventually be sold for.
  constraint fixed_assets_salvage_under_cost check (salvage_value_cents <= cost_cents),
  constraint fixed_assets_disposed_after_acquired check (disposed_on is null or disposed_on >= acquired_on),
  -- Proceeds only mean anything once it has gone. Without this a live asset
  -- could carry a sale price and the disposal report would count money that
  -- has not been received.
  constraint fixed_assets_proceeds_need_disposal check (disposal_proceeds_cents is null or disposed_on is not null)
);
create index fixed_assets_shop_idx on public.fixed_assets(shop_id);
create index fixed_assets_shop_live_idx on public.fixed_assets(shop_id) where disposed_on is null;

alter table public.fixed_assets enable row level security;

-- Readable at the same bar as the chart: the asset register IS a line of the
-- balance sheet, and a reader who can see "Fixed assets $12,400" should be
-- able to see the four things that make it up.
create policy "read fixed_assets" on public.fixed_assets for select
  using (has_any_shop_permission(shop_id, array['ledger.view', 'ledger.manage', 'expenses.view']));
create policy "write fixed_assets" on public.fixed_assets for all
  using (has_shop_permission(shop_id, 'ledger.manage'))
  with check (has_shop_permission(shop_id, 'ledger.manage'));

grant select, insert, update, delete on public.fixed_assets to authenticated;

-- Disposal is an ordinary UPDATE through the policy above rather than an RPC.
-- There is nothing for an RPC to make atomic: no balance moves, no entry is
-- posted, and the two things that must stay true -- a disposal date on or
-- after acquisition, proceeds only on something disposed of -- are constraints
-- on the row, which a client cannot route around the way it could route around
-- a function it simply declined to call.

create trigger fixed_assets_audit after insert or update or delete on public.fixed_assets
  for each row execute function public.log_accounting_change('fixed_asset', 'name');
