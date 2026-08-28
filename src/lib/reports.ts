import { listLocations } from '@/lib/locations';
import {
  categoryLabel,
  effectiveReorderLevel,
  employeeLabel,
  sequenceMovements,
  type LabelledLine,
  type LabelledSale,
  type MovementRow,
} from '@/lib/report-math';
import { getSalesAndRefundsInRange } from '@/lib/sales';
import type { PeriodRefund } from '@/lib/sales-reporting';
import { supabase } from '@/lib/supabase';
import type { Sale, ShopLocation } from '@/types/models';

// The reads the seven reports need, and the row -> model shaping that goes with
// them. The arithmetic is next door in report-math.ts and imports nothing from
// here: this module reaches the Supabase client (directly or through sales.ts),
// which cannot load under Jest.
//
// WHY THE SALES REPORTS DO NOT ISSUE THEIR OWN QUERIES. Four of the seven read
// sales and sale items, and sales.ts already has that read -- paginated past
// PostgREST's 1000-row cap, with a mapping that unpacks items, payments, edits
// and refunds and has been corrected several times for things this file would
// have to get right again from scratch (goods_cents falling back to
// total_cents, tax_rate_percent arriving as a string, an edit's snapshot).
// A second implementation of it here would be a second opinion on what a sale
// is, and the two would disagree the first time one of them was fixed. So the
// four sales reports take `getSalesAndRefundsInRange` and shape its result;
// only the three inventory reports, which have no existing read in the shape
// they need, query for themselves.

// ---------------------------------------------------------------------------
// The sales reports (Tasks 3-6)
// ---------------------------------------------------------------------------

export type SalesReportData = {
  sales: Sale[];
  refunds: PeriodRefund[];
  /** Every branch, so a store row can be named rather than shown as a uuid. */
  locations: ShopLocation[];
};

/**
 * One read for all four sales reports.
 *
 * `getSalesAndRefundsInRange` is the heaviest query in the app, so it is issued
 * ONCE per screen and every figure derived from the result -- the note on that
 * function says exactly this. A view that wanted revenue and margin and a
 * per-day series would otherwise refetch the same rows three times.
 *
 * `locationId` null is the combined business view, matching the shell's store
 * filter and `scopeToLocation`.
 */
export async function loadSalesReport(
  shopId: string,
  since: Date,
  until: Date | undefined,
  locationId: string | null
): Promise<SalesReportData> {
  const [{ sales, refunds }, locations] = await Promise.all([
    getSalesAndRefundsInRange(shopId, since, until, locationId),
    listLocations(shopId),
  ]);
  return { sales, refunds, locations };
}

/**
 * What a single basket earned the shop: everything the customer handed over,
 * less the sales tax the shop is only holding on the government's behalf.
 *
 * Tax is excluded for the reason `netRevenueCents` excludes it -- it is a
 * liability owed onward, not income -- so a per-cashier or per-store column
 * headed "revenue" has to exclude it too, or the same word means two different
 * figures on two screens.
 *
 * Refunds are NOT netted off here, and the screens that use this say so out
 * loud. A refund is processed by whoever is on the till when the customer comes
 * back, which is rarely whoever made the sale, so subtracting it from either
 * one of them is a guess: charge it to the original cashier and you have
 * punished them for a decision someone else made; charge it to the refunder and
 * a cashier who is generous with refunds looks like a poor seller. The shop's
 * refunds belong in the shop's totals, which is where `netRevenueCents` puts
 * them.
 */
export function saleRevenueCents(sale: Sale): number {
  return sale.totalCents - sale.taxCents;
}

// `Sale.items` is optional on the model because some reads do not select the
// line rows at all -- `?? []` is for those, not for a sale that genuinely has
// no lines. Every read in this file goes through `getSalesAndRefundsInRange`,
// which always selects them.
function saleItems(sale: Sale) {
  return sale.items ?? [];
}

function saleUnits(sale: Sale): number {
  return saleItems(sale).reduce((sum, item) => sum + item.quantity, 0);
}

/** Every sale tagged with the cashier it is reported against. */
export function salesByEmployee(sales: Sale[]): LabelledSale[] {
  return sales.map((sale) => {
    const label = employeeLabel(sale.cashierName);
    return {
      // Keyed on the LABEL, not on `created_by`. Two sales rung up under the
      // same name by the same person before and after they were given a login
      // are one cashier to the shop, and `cashier_name` is the frozen snapshot
      // the till actually recorded -- `created_by` is null on every sale made
      // from a shared device.
      key: label,
      label,
      revenueCents: saleRevenueCents(sale),
      units: saleUnits(sale),
    };
  });
}

/** Every sale tagged with the branch that rang it up. */
export function salesByStore(sales: Sale[], locations: ShopLocation[]): LabelledSale[] {
  const names = new Map(locations.map((location) => [location.id, location.name]));
  return sales.map((sale) => ({
    key: sale.locationId,
    // A branch deleted from the list but still on old sales must not become a
    // blank row. `location_id` is not null on any sale (migration
    // 20260809000000 backfilled every pre-existing one), so this is about a
    // location the CURRENT read did not return, not about missing data.
    label: names.get(sale.locationId) ?? 'Unknown store',
    revenueCents: saleRevenueCents(sale),
    units: saleUnits(sale),
  }));
}

/**
 * Every sale LINE tagged with the product it sold.
 *
 * Keyed on the product id where there is one and on the frozen name where there
 * is not: `sale_items.product_id` is set null when a product is deleted, and
 * keying every one of those on the same null would merge a shop's entire
 * deleted back-catalogue into a single row called whatever the first one
 * happened to be.
 */
export function linesByProduct(sales: Sale[]): LabelledLine[] {
  return sales.flatMap((sale) =>
    saleItems(sale).map((item) => ({
      key: item.productId ?? `deleted:${item.productName}`,
      label: item.productName,
      lineTotalCents: item.lineTotalCents,
      unitCostCents: item.unitCostCents,
      quantity: item.quantity,
    }))
  );
}

/**
 * Every sale line tagged with its product's category.
 *
 * The category is read from the products table LIVE, not frozen on the line, so
 * recategorising a product restates its past sales. That is the right way round
 * for this report: "how are my drinks doing" is a question about the shelf as it
 * is organised today, and the alternative would report a product under a
 * category the shop has since abandoned.
 *
 * A line whose product was deleted has no category to read and falls into
 * Uncategorised with the rest, which is honest -- nobody can say what it was.
 */
export function linesByCategory(sales: Sale[], categories: Map<string, string | null>): LabelledLine[] {
  return sales.flatMap((sale) =>
    saleItems(sale).map((item) => {
      const label = categoryLabel(item.productId === null ? null : categories.get(item.productId));
      return {
        key: label,
        label,
        lineTotalCents: item.lineTotalCents,
        unitCostCents: item.unitCostCents,
        quantity: item.quantity,
      };
    })
  );
}

// ---------------------------------------------------------------------------
// Stock on hand (Tasks 7 and 8)
// ---------------------------------------------------------------------------

// PostgREST caps an unbounded select at 1000 rows and returns the first page
// with no error, so a shop with 400 products across three branches would see a
// stock report that silently stopped two thirds of the way down. Local rather
// than shared with sales.ts's identical helper only because that one is not
// exported; if a third caller appears, hoist both.
const PAGE_SIZE = 1000;

async function fetchAllRows<T>(runPage: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>): Promise<T[]> {
  const all: T[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await runPage(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    const rows = data ?? [];
    all.push(...rows);
    if (rows.length < PAGE_SIZE) break;
  }
  return all;
}

/** One product's stock at one store, with everything needed to judge it. */
export type StockOnHandRow = {
  productId: string;
  productName: string;
  category: string | null;
  locationId: string;
  locationName: string;
  stock: number;
  /**
   * What one unit cost, from `products.cost_cents`. Null where nobody has
   * costed the product -- null and not zero, because zero is a real answer.
   */
  costCents: number | null;
  /**
   * The level in force here: the branch override, else the product's own, else
   * the shop's `default_low_stock_level`. Never null -- there is always an
   * answer, which is the whole correction this type carries.
   */
  reorderLevel: number;
};

type StockOnHandDbRow = {
  product_id: string;
  location_id: string;
  stock: number;
  reorder_level: number | null;
  products: { name: string; category: string | null; cost_cents: number | null; reorder_level: number | null } | null;
};

/**
 * Stock on hand per product per store, for Inventory Balance and Low Stock.
 *
 * `shopDefaultLowStockLevel` is `shops.default_low_stock_level`, and passing it
 * is what makes this agree with the rest of the app. The first version of this
 * file said the opposite -- that using the shop default "turns 'nobody has set
 * a level' into 'the level is 5'" -- and that was simply wrong about the data
 * model. Migration 0030 added the column precisely to replace a hardcoded 5,
 * it is `not null default 5` and editable at Settings -> Inventory alerts, and
 * a blank `reorder_level` has always meant "use it" everywhere else in the
 * app. Reading a blank as unanswered made this report disagree with the
 * Inventory tab about which products were low.
 *
 * Read from `product_location_stock`, not from `products.stock`: the shop-wide
 * rollup hides a branch that is out of an item while another overflows, and
 * that branch is the one that needs reordering. That part was right, and is
 * still the reason this does not simply call `getLowStockProducts`.
 *
 * A row with no `products` join is dropped. It cannot happen through the
 * foreign key (`on delete cascade`), and inventing a name for it would put a
 * row called "Unknown" on a reorder list nobody can act on.
 */
export async function loadStockOnHand(
  shopId: string,
  locationId: string | null,
  locations: ShopLocation[],
  shopDefaultLowStockLevel: number
): Promise<StockOnHandRow[]> {
  const rows = await fetchAllRows<StockOnHandDbRow>((from, to) => {
    let query = supabase
      .from('product_location_stock')
      .select('product_id, location_id, stock, reorder_level, products!inner(name, category, cost_cents, reorder_level, shop_id)')
      .eq('products.shop_id', shopId);
    if (locationId) query = query.eq('location_id', locationId);
    return query.range(from, to) as unknown as PromiseLike<{ data: StockOnHandDbRow[] | null; error: unknown }>;
  });

  const names = new Map(locations.map((location) => [location.id, location.name]));
  return rows
    .filter((row): row is StockOnHandDbRow & { products: NonNullable<StockOnHandDbRow['products']> } => row.products !== null)
    .map((row) => ({
      productId: row.product_id,
      productName: row.products.name,
      category: row.products.category,
      locationId: row.location_id,
      locationName: names.get(row.location_id) ?? 'Unknown store',
      stock: row.stock,
      costCents: row.products.cost_cents,
      reorderLevel: effectiveReorderLevel(row.reorder_level, row.products.reorder_level, shopDefaultLowStockLevel),
    }));
}

/** Stock on hand plus the branch list, which the store column needs to name. */
export async function loadInventoryReport(
  shopId: string,
  locationId: string | null,
  shopDefaultLowStockLevel: number
): Promise<StockOnHandRow[]> {
  const locations = await listLocations(shopId);
  return loadStockOnHand(shopId, locationId, locations, shopDefaultLowStockLevel);
}

// ---------------------------------------------------------------------------
// Categories (Task 6)
// ---------------------------------------------------------------------------

/**
 * Every product's category, for tagging sale lines.
 *
 * Two columns rather than `listProducts`, which selects `*` plus every
 * product's per-store stock rows -- three joins and a hundred columns to read
 * one string per product.
 */
export async function loadProductCategories(shopId: string): Promise<Map<string, string | null>> {
  const rows = await fetchAllRows<{ id: string; category: string | null }>((from, to) =>
    supabase.from('products').select('id, category').eq('shop_id', shopId).range(from, to)
  );
  return new Map(rows.map((row) => [row.id, row.category]));
}

/** Sale lines tagged with their product's category, in one read. */
export async function loadCategoryReport(
  shopId: string,
  since: Date,
  until: Date | undefined,
  locationId: string | null
): Promise<LabelledLine[]> {
  const [{ sales }, categories] = await Promise.all([
    loadSalesReport(shopId, since, until, locationId),
    loadProductCategories(shopId),
  ]);
  return linesByCategory(sales, categories);
}

// ---------------------------------------------------------------------------
// Stock movement (Task 9)
// ---------------------------------------------------------------------------

// THREE TABLES, ONE SEQUENCE, NORMALISED HERE. `stock_receipts`,
// `stock_transfers` and `stock_counts` have different shapes and different
// notions of what a quantity is, and "what happened to my stock" is a single
// list. A component interleaving three arrays would be a fourth place the
// ordering rule could be wrong, so they become `MovementRow` before they leave
// this file and `sequenceMovements` puts them in order.
//
// WHY THERE IS NO "WHO" COLUMN, and why `by` is always null. Every one of the
// three tables records `created_by` as an auth.users uuid, and nothing readable
// turns that into a name: `profiles` carries only the "own profile" policy, so
// a reader sees their own row and nobody else's -- which is why the audit log
// renders "A person" rather than a name. The one mapping that does exist,
// `shop_members.full_name`, is reachable only through `list_shop_staff`, and
// that function RAISES `not authorized for shop %` for anyone without
// staff.manage, people.payroll.manage, people.timesheet.view or
// people.timeoff.approve (migration 20260803010000). Calling it here would
// throw the whole screen for a stock clerk looking at deliveries, and would
// make this the one report of the seven depending on an RPC that raises --
// which by the hub's own rule would force its card to be gated. A column
// reading "A person" on every row is not worth either price. `by` stays on
// MovementRow for the day a readable mapping exists.

type ReceiptDbRow = {
  id: string;
  created_at: string;
  supplier_name: string | null;
  reference: string | null;
  location_id: string;
  stock_receipt_items: { quantity: number }[] | null;
};

type TransferDbRow = {
  id: string;
  created_at: string;
  note: string | null;
  from_location_id: string;
  to_location_id: string;
  stock_transfer_items: { quantity: number }[] | null;
};

type CountDbRow = {
  id: string;
  created_at: string;
  note: string | null;
  location_id: string;
  stock_count_items: { variance: number }[] | null;
};

function sumBy<T>(rows: T[] | null, value: (row: T) => number): number {
  return (rows ?? []).reduce((sum, row) => sum + value(row), 0);
}

/** Everything that happened to stock in the range, as one ordered sequence. */
export async function loadStockMovement(
  shopId: string,
  since: Date,
  until: Date | undefined,
  locationId: string | null
): Promise<MovementRow[]> {
  const from = since.toISOString();
  const to = until?.toISOString();
  const locations = await listLocations(shopId);
  const names = new Map(locations.map((location) => [location.id, location.name]));
  const named = (id: string) => names.get(id) ?? 'Unknown store';

  const [receipts, transfers, counts] = await Promise.all([
    fetchAllRows<ReceiptDbRow>((a, b) => {
      let query = supabase
        .from('stock_receipts')
        .select('id, created_at, supplier_name, reference, location_id, stock_receipt_items(quantity)')
        .eq('shop_id', shopId)
        .gte('created_at', from);
      if (to) query = query.lte('created_at', to);
      if (locationId) query = query.eq('location_id', locationId);
      return query.range(a, b) as unknown as PromiseLike<{ data: ReceiptDbRow[] | null; error: unknown }>;
    }),
    fetchAllRows<TransferDbRow>((a, b) => {
      let query = supabase
        .from('stock_transfers')
        .select('id, created_at, note, from_location_id, to_location_id, stock_transfer_items(quantity)')
        .eq('shop_id', shopId)
        .gte('created_at', from);
      if (to) query = query.lte('created_at', to);
      // Either end of the move counts as this branch's business: stock leaving
      // the kiosk is as much a kiosk movement as stock arriving there, and a
      // filter on one end alone would hide half of them.
      if (locationId) query = query.or(`from_location_id.eq.${locationId},to_location_id.eq.${locationId}`);
      return query.range(a, b) as unknown as PromiseLike<{ data: TransferDbRow[] | null; error: unknown }>;
    }),
    fetchAllRows<CountDbRow>((a, b) => {
      let query = supabase
        .from('stock_counts')
        .select('id, created_at, note, location_id, stock_count_items(variance)')
        .eq('shop_id', shopId)
        .gte('created_at', from);
      if (to) query = query.lte('created_at', to);
      if (locationId) query = query.eq('location_id', locationId);
      return query.range(a, b) as unknown as PromiseLike<{ data: CountDbRow[] | null; error: unknown }>;
    }),
  ]);

  return sequenceMovements([
    ...receipts.map((row): MovementRow => ({
      id: row.id,
      kind: 'received',
      at: row.created_at,
      // `what` is the row's OWN words -- a supplier here, a note on the other
      // two -- and never the kind, which the Kind column already names. The
      // first cut defaulted this to the kind noun and a real shop rendered
      // eight stock-takes reading "Stock-take" in both columns. Empty is
      // rendered as an em dash by the view, which says "nobody wrote anything"
      // rather than repeating what is already on the row.
      what: row.supplier_name?.trim() || '',
      detail: row.reference,
      where: named(row.location_id),
      by: null,
      units: sumBy(row.stock_receipt_items, (item) => item.quantity),
    })),
    ...transfers.map((row): MovementRow => ({
      id: row.id,
      kind: 'transfer',
      at: row.created_at,
      what: row.note?.trim() || '',
      detail: null,
      where: `${named(row.from_location_id)} → ${named(row.to_location_id)}`,
      by: null,
      // Positive: a transfer MOVES stock rather than changing how much there
      // is, so this is units moved and the KPI strip totals it apart from the
      // other two rather than adding it to them.
      units: sumBy(row.stock_transfer_items, (item) => item.quantity),
    })),
    ...counts.map((row): MovementRow => ({
      id: row.id,
      kind: 'count',
      at: row.created_at,
      what: row.note?.trim() || '',
      detail: null,
      where: named(row.location_id),
      by: null,
      // SIGNED, and never absolute. `variance` is counted minus previous, so a
      // stock-take that wrote 284 units off is -284 -- which is the fact the
      // report exists to show, and an absolute value would render it as a gain.
      units: sumBy(row.stock_count_items, (item) => item.variance),
    })),
  ]);
}
