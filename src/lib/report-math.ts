// Every decision the seven reports make, as pure functions over plain inputs.
//
// THE SCREENS DO NO ARITHMETIC. A percentage, a subtotal, a shortfall, a
// ranking, a bucket boundary -- all of it lives here and is tested here. A
// screen that sums its own rows is a second implementation of the report, and
// the two disagree the first time a rounding rule changes, at which point
// nobody knows which one is right. This project has paid for that repeatedly.
//
// That is also why the seven views get no Jest test of their own: if a view
// ends up making a decision, the decision belongs in this file instead.
//
// No Supabase import, and no React. `src/lib/reports.ts` does the reading and
// the row -> model mapping; this file only ever sees plain objects, which is
// what makes it testable without a runtime -- the same split expense-reporting
// draws from expenses.

// ---------------------------------------------------------------------------
// Revenue, cost and margin
// ---------------------------------------------------------------------------

export type ProfitLine = {
  /** What the line sold for, after its own discount. */
  lineTotalCents: number;
  /**
   * The cost of ONE unit at the time of sale, or null when none was recorded.
   * Nullable because `sale_items.unit_cost_cents` is: a product sold before its
   * cost was ever set has no cost, and never will retrospectively.
   */
  unitCostCents: number | null;
  quantity: number;
};

/**
 * Revenue, cost and how much of the cost is missing.
 *
 * An uncosted line still SOLD something, so it counts towards revenue; it just
 * has no cost to subtract. Dropping it from revenue as well would make the
 * report's takings smaller than the shop's, which is the worse of the two
 * lies -- so instead the count comes back with the figures and the screen says
 * so out loud.
 */
export function grossProfitCents(lines: ProfitLine[]): {
  revenueCents: number;
  costCents: number;
  uncostedLines: number;
} {
  let revenueCents = 0;
  let costCents = 0;
  let uncostedLines = 0;
  for (const line of lines) {
    revenueCents += line.lineTotalCents;
    if (line.unitCostCents === null) {
      uncostedLines += 1;
      continue;
    }
    // Per UNIT, times the units sold. Reading unit cost as line cost
    // understates cost of sales by (quantity - 1) times on every multi-unit
    // line, which on a grocery basket is most of them.
    costCents += line.unitCostCents * line.quantity;
  }
  return { revenueCents, costCents, uncostedLines };
}

/**
 * Gross margin as a percentage, or null when there is no revenue to take one of.
 *
 * Null rather than 0: 0% reads as "sold at cost", which is a fact about a
 * trading day. "Nothing sold" is a different fact and the screen renders it
 * differently (an em dash, not a figure).
 *
 * Negative margins come back negative rather than clamped. Selling below cost
 * is real, it happens on clearance and on mispriced lines, and it is exactly
 * the thing a margin report exists to surface.
 */
export function marginPercent(revenueCents: number, costCents: number): number | null {
  if (revenueCents === 0) return null;
  return ((revenueCents - costCents) / revenueCents) * 100;
}

/**
 * A mean in whole cents, or null when there is nothing to take a mean of.
 *
 * Null rather than 0 for the reason `marginPercent` returns null: "the average
 * basket was $0.00" is a claim about a trading day, and a day with no sales in
 * it did not have an average basket of nothing -- it did not have one. The
 * screens render the difference as an em dash.
 *
 * Rounded, because a fraction of a cent formatted as money prints its full
 * float ("$3.3333333333333335").
 */
export function averageCents(totalCents: number, count: number): number | null {
  if (count === 0) return null;
  return Math.round(totalCents / count);
}

/**
 * One figure's share of a total, as a percentage, or null when the total is
 * zero. Same reason `marginPercent` returns null: a share of nothing is not 0%.
 */
export function shareOfTotal(partCents: number, totalCents: number): number | null {
  if (totalCents === 0) return null;
  return (partCents / totalCents) * 100;
}

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

/**
 * Rows bucketed by a key, preserving the order rows arrived in both between
 * groups and within one.
 *
 * Built on a null-prototype object rather than `{}` because the keys are user
 * data: a product category (or a cashier name, or a store) called
 * `__proto__` assigned onto a plain object sets the prototype instead of a
 * property, and the group silently vanishes from the report.
 */
export function groupBy<T, K extends string>(rows: T[], key: (row: T) => K): Record<K, T[]> {
  const out = Object.create(null) as Record<K, T[]>;
  for (const row of rows) {
    const k = key(row);
    if (out[k] === undefined) out[k] = [];
    out[k].push(row);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Roll-ups
// ---------------------------------------------------------------------------

/** A sale line tagged with the bucket it belongs to. */
export type LabelledLine = ProfitLine & {
  /** What groups the line: a product id, a category name, a store id. */
  key: string;
  /** What the row is called on screen. */
  label: string;
};

export type RollUpRow = {
  key: string;
  label: string;
  revenueCents: number;
  costCents: number;
  /** Null when the bucket took nothing -- see `marginPercent`. */
  marginPercent: number | null;
  units: number;
  /** Sale LINES, not sales. Two of the same product in one basket is one line. */
  lines: number;
  uncostedLines: number;
};

/**
 * Sale lines bucketed and totalled, biggest earner first.
 *
 * The sort is TOTAL, not merely "by revenue": ties break on the label and then
 * on the key. Two categories that took exactly the same money -- which happens
 * constantly at zero -- would otherwise sit in whichever order the rows
 * happened to arrive in, and the table would reshuffle itself between
 * refreshes. `sequenceMovements` breaks its ties for the same reason.
 *
 * Revenue and cost come from `grossProfitCents`, so the uncosted rule is stated
 * once: an uncosted line still sold something and still counts towards revenue.
 */
export function rollUpLines(rows: LabelledLine[]): RollUpRow[] {
  const grouped = groupBy(rows, (row) => row.key);
  return Object.entries(grouped)
    .map(([key, lines]) => {
      const { revenueCents, costCents, uncostedLines } = grossProfitCents(lines);
      return {
        key,
        label: lines[0].label,
        revenueCents,
        costCents,
        marginPercent: marginPercent(revenueCents, costCents),
        units: lines.reduce((sum, line) => sum + line.quantity, 0),
        lines: lines.length,
        uncostedLines,
      };
    })
    .sort((a, b) => b.revenueCents - a.revenueCents || a.label.localeCompare(b.label) || a.key.localeCompare(b.key));
}

/** A whole sale tagged with the bucket it belongs to -- a cashier, a store. */
export type LabelledSale = {
  key: string;
  label: string;
  /** What the sale earned. Whichever figure the caller means by revenue. */
  revenueCents: number;
  units: number;
};

export type SaleGroupRow = {
  key: string;
  label: string;
  revenueCents: number;
  /**
   * SALES, not lines. A basket is a transaction, and a cashier who rang up one
   * enormous order did not serve forty people.
   */
  sales: number;
  units: number;
  /** Mean take per sale. A group only exists because it has a sale in it. */
  averageSaleCents: number;
};

/**
 * Whole sales bucketed and totalled, biggest earner first.
 *
 * Separate from `rollUpLines` because the unit of counting differs and the
 * difference is the whole point: a per-cashier report counts BASKETS, and
 * counting lines instead would rank the cashier who serves the fussiest
 * customers top. Ties break the same total way, for the same reason.
 */
export function rollUpSales(rows: LabelledSale[]): SaleGroupRow[] {
  const grouped = groupBy(rows, (row) => row.key);
  return Object.entries(grouped)
    .map(([key, sales]) => {
      const revenueCents = sales.reduce((sum, sale) => sum + sale.revenueCents, 0);
      return {
        key,
        label: sales[0].label,
        revenueCents,
        sales: sales.length,
        units: sales.reduce((sum, sale) => sum + sale.units, 0),
        // No divide-by-zero guard, deliberately: `sales.length` is at least 1
        // because the group was created by a row landing in it. A guard here
        // would be dead code pretending to be a safety net.
        averageSaleCents: Math.round(revenueCents / sales.length),
      };
    })
    .sort((a, b) => b.revenueCents - a.revenueCents || a.label.localeCompare(b.label) || a.key.localeCompare(b.key));
}

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

/** The bucket a product with no category falls into. */
export const UNCATEGORISED = 'Uncategorised';

/** The bucket a sale with no cashier recorded against it falls into. */
export const UNATTRIBUTED = 'Not recorded';

/**
 * The cashier a sale is reported against.
 *
 * `sales.cashier_name` is nullable -- a sale rung up before cashier profiles
 * existed, or by an owner who never set one, carries no name -- and those sales
 * are a ROW, not a filter, on exactly the argument `categoryLabel` makes: drop
 * them and the per-cashier revenues add to less than the shop took, and the
 * reader checking the total against the day's takings finds it short with
 * nothing on screen to explain it.
 *
 * Whitespace counts as blank, so a name of `' '` does not become a second,
 * invisible cashier beside the real one.
 */
export function employeeLabel(cashierName: string | null | undefined): string {
  const trimmed = (cashierName ?? '').trim();
  return trimmed.length > 0 ? trimmed : UNATTRIBUTED;
}

/**
 * A product's category as the report labels it.
 *
 * UNCATEGORISED IS A ROW, NOT A FILTER. `products.category` is nullable and 175
 * of this shop's products leave it blank; hiding them would make every
 * percentage on the category report add to less than the shop actually took,
 * and a reader checking the total against the day's takings would find the
 * report short with nothing on screen to explain it.
 *
 * Whitespace counts as blank. A category of `' '` came in through CSV import
 * and would otherwise be a second, invisible bucket beside the real one.
 */
export function categoryLabel(category: string | null | undefined): string {
  const trimmed = (category ?? '').trim();
  return trimmed.length > 0 ? trimmed : UNCATEGORISED;
}

// ---------------------------------------------------------------------------
// Stock on hand
// ---------------------------------------------------------------------------

/**
 * What stock is worth at the cost currently recorded against each product, and
 * how many rows had no cost to value.
 *
 * A null cost is UNKNOWN and a zero cost is FREE, and they must not merge. A
 * shop with fourteen products it has never costed would otherwise read
 * "valued at $28,411" with no hint that a slice of the shelves is missing from
 * the number.
 */
export function stockValueCents(rows: { stock: number; costCents: number | null }[]): {
  valueCents: number;
  unvalued: number;
} {
  let valueCents = 0;
  let unvalued = 0;
  for (const row of rows) {
    if (row.costCents === null) {
      unvalued += 1;
      continue;
    }
    valueCents += row.stock * row.costCents;
  }
  return { valueCents, unvalued };
}

export type ReorderRow = { stock: number; reorderLevel: number | null };

/**
 * How many units short of the reorder level a row is, or null when no level is
 * set for it.
 *
 * NULL IS NOT ZERO. `product_location_stock.reorder_level` is nullable and most
 * shops leave it blank; treating a blank as zero would report every product as
 * adequately stocked and hand the reader an empty report that reads like good
 * news. Zero means "at or above the level"; null means "nobody has said what
 * the level is".
 */
export function reorderShortfall(row: ReorderRow): number | null {
  if (row.reorderLevel === null) return null;
  return Math.max(0, row.reorderLevel - row.stock);
}

export type StockUrgency = 'out' | 'critical' | 'low';

/**
 * How badly a row needs reordering, or null when it does not (or when nobody
 * has set a level for it).
 *
 * Out is nothing on the shelf, which is a lost sale happening now. Critical is
 * at or under half the level, which is the boundary at which a normal delivery
 * cycle stops covering it. Everything else short is Low.
 */
export function reorderUrgency(row: ReorderRow): StockUrgency | null {
  const short = reorderShortfall(row);
  if (short === null || short === 0) return null;
  if (row.stock <= 0) return 'out';
  // reorderLevel is non-null here: reorderShortfall returned a number.
  return row.stock * 2 <= (row.reorderLevel as number) ? 'critical' : 'low';
}

export type LowStockRow<T extends ReorderRow> = T & { shortfall: number; urgency: StockUrgency };

/**
 * Why a low-stock report is empty, when it is.
 *
 * 'none-configured' and 'nothing-low' are DIFFERENT FACTS and an empty state
 * that means the first while reading like the second is a lie -- it tells a
 * shop that has never set a reorder level in its life that its shelves are
 * fine. Null means the report is not empty.
 */
export type LowStockEmptyReason = 'none-configured' | 'nothing-low' | null;

/**
 * The low-stock report: what is short, worst first, and — when nothing is —
 * which of the two reasons that is.
 */
export function lowStockReading<T extends ReorderRow>(
  rows: T[]
): { rows: LowStockRow<T>[]; configured: number; emptyReason: LowStockEmptyReason } {
  const configured = rows.filter((row) => row.reorderLevel !== null).length;
  const short: LowStockRow<T>[] = [];
  for (const row of rows) {
    const shortfall = reorderShortfall(row);
    const urgency = reorderUrgency(row);
    if (shortfall === null || shortfall === 0 || urgency === null) continue;
    short.push({ ...row, shortfall, urgency });
  }
  // Worst first, because a reorder list is read from the top and a buyer who
  // stops halfway must have covered the worst of it.
  short.sort((a, b) => b.shortfall - a.shortfall);
  return {
    rows: short,
    configured,
    emptyReason: short.length > 0 ? null : configured === 0 ? 'none-configured' : 'nothing-low',
  };
}

// ---------------------------------------------------------------------------
// Stock movement
// ---------------------------------------------------------------------------

export type MovementKind = 'received' | 'transfer' | 'count';

/**
 * One thing that happened to stock, whichever of the three tables it came from.
 *
 * `stock_receipts`, `stock_transfers` and `stock_counts` have different shapes
 * and are normalised into this ONE type IN `reports.ts`, not in a component --
 * "what happened to my stock" is a single sequence, and a component that
 * interleaves three lists is a fourth place the ordering rule can be wrong.
 *
 * `at` is the date column AS THE DATABASE GAVE IT, never a Date. Date-only
 * strings parse as UTC midnight and render as the previous day west of
 * Greenwich, and this project has shipped that bug. Ordering below is
 * lexicographic, which is correct for ISO-8601 and needs no parsing at all.
 */
export type MovementRow = {
  id: string;
  kind: MovementKind;
  /** An ISO date or timestamp string. Compared as text, never parsed here. */
  at: string;
  /** The headline: a supplier, a reason, a list of products. */
  what: string;
  /** The second line, if any: a GRN number, a count reason. */
  detail: string | null;
  /** Where it happened, or moved between. */
  where: string;
  /** Who did it, or null when the record does not say. */
  by: string | null;
  /**
   * Signed units. Positive for stock arriving, negative for stock a count wrote
   * off. A transfer moves rather than changes stock, so it carries the units
   * moved as a positive figure and is totalled separately.
   */
  units: number;
};

/**
 * The three sources as one sequence, newest first.
 *
 * Ties break on `id` so the order is total and stable: two deliveries booked on
 * the same day would otherwise sit in whichever order the three queries
 * happened to resolve in, and the list would reshuffle between refreshes.
 */
export function sequenceMovements(rows: MovementRow[]): MovementRow[] {
  return [...rows].sort((a, b) => (a.at === b.at ? a.id.localeCompare(b.id) : a.at < b.at ? 1 : -1));
}

/**
 * The movement KPI strip: units and record count per kind.
 *
 * Counted units stay signed, because a stock-take that wrote 284 units off is
 * the fact the strip exists to show, and an absolute value would render it as
 * a gain.
 */
export function movementTotals(rows: MovementRow[]): Record<MovementKind, { units: number; count: number }> {
  const totals: Record<MovementKind, { units: number; count: number }> = {
    received: { units: 0, count: 0 },
    transfer: { units: 0, count: 0 },
    count: { units: 0, count: 0 },
  };
  for (const row of rows) {
    totals[row.kind].units += row.units;
    totals[row.kind].count += 1;
  }
  return totals;
}
