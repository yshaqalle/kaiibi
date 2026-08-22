import { soldAfterRefunds } from '@/lib/sales-reporting';
import type { Sale } from '@/types/models';

// What each product actually earned: units, revenue, cost, and the profit
// left over.
//
// `productPerformance` in sales-reporting.ts already ranks products by
// revenue, and revenue is the wrong ranking to act on. The line that brings in
// the most money is regularly not the line that makes the most: a $40 bottle
// bought for $37 earns less than four $3 packets bought for $1. A shop that
// reorders off the revenue list keeps buying its worst stock.
//
// So this reports margin alongside revenue, and lets the reader sort by
// either.
//
// Built on the same `soldAfterRefunds` basis as every other product ranking --
// see its comment there for what a return does to a period. Pure, so the
// arithmetic is testable without a database.

export type ItemPerformanceRow = {
  /** Null once the product itself is deleted; kept in the key so two deleted products stay apart. */
  productId: string | null;
  name: string;
  unitsSold: number;
  revenueCents: number;
  /** What those units cost, from the cost frozen onto each line at sale time. */
  costCents: number;
  grossProfitCents: number;
  /** Gross profit over revenue. Null when nothing sold, or when the cost is unknown. */
  marginPct: number | null;
  /**
   * Units sold with no cost recorded against them.
   *
   * The margin on those units is not zero, it is UNKNOWN, and the difference
   * decides whether a reader should act on the figure. A row that is mostly
   * uncosted has a profit figure that only covers the rest of it.
   */
  uncostedUnits: number;
  /** Revenue per unit — what it actually sold for after discounts. */
  averagePriceCents: number;
};

export type ItemPerformance = {
  rows: ItemPerformanceRow[];
  totalRevenueCents: number;
  totalCostCents: number;
  totalGrossProfitCents: number;
  /** Units across every row whose cost was never recorded. */
  uncostedUnits: number;
};

export type ItemPerformanceSort = 'revenue' | 'profit' | 'units' | 'margin';

/**
 * Ranks what sold.
 *
 * `limit` caps the rows returned; pass 0 for all of them. The cap is on the
 * SORTED list, so the totals are computed over everything first -- a top-ten
 * whose totals only add up the top ten would report a shop that sold far less
 * than it did.
 */
export function itemPerformance(
  sales: Sale[],
  { sort = 'profit', limit = 0 }: { sort?: ItemPerformanceSort; limit?: number } = {}
): ItemPerformance {
  const totals = new Map<string, ItemPerformanceRow>();

  for (const sale of sales) {
    for (const item of sale.items ?? []) {
      const { unitsSold, revenueCents } = soldAfterRefunds(sale, item);
      if (unitsSold <= 0) continue;

      const uncosted = item.unitCostCents === null;
      const costCents = uncosted ? 0 : unitsSold * (item.unitCostCents ?? 0);

      const key = item.productId ?? `name:${item.productName}`;
      const row = totals.get(key);
      if (row) {
        row.unitsSold += unitsSold;
        row.revenueCents += revenueCents;
        row.costCents += costCents;
        if (uncosted) row.uncostedUnits += unitsSold;
      } else {
        totals.set(key, {
          productId: item.productId,
          // The frozen line name, not the product's current one, so a product
          // renamed since does not rewrite what last month sold as.
          name: item.productName,
          unitsSold,
          revenueCents,
          costCents,
          grossProfitCents: 0,
          marginPct: null,
          uncostedUnits: uncosted ? unitsSold : 0,
          averagePriceCents: 0,
        });
      }
    }
  }

  const rows = [...totals.values()].map((row) => {
    const grossProfitCents = row.revenueCents - row.costCents;
    return {
      ...row,
      grossProfitCents,
      // Null when every unit was uncosted: there is no margin to state, and
      // printing 100% would say the shop got the goods free.
      marginPct:
        row.revenueCents > 0 && row.uncostedUnits < row.unitsSold
          ? Math.round((grossProfitCents / row.revenueCents) * 100)
          : null,
      averagePriceCents: row.unitsSold > 0 ? Math.round(row.revenueCents / row.unitsSold) : 0,
    };
  });

  const sorted = [...rows].sort((a, b) => {
    switch (sort) {
      case 'units':
        return b.unitsSold - a.unitsSold || b.revenueCents - a.revenueCents;
      case 'revenue':
        return b.revenueCents - a.revenueCents || b.unitsSold - a.unitsSold;
      case 'margin':
        // Rows with no known margin sort last rather than as 0%: an unknown is
        // not a bad result, and burying it at the bottom of a "worst margin"
        // list is how it gets mistaken for one.
        if (a.marginPct === null && b.marginPct === null) return b.revenueCents - a.revenueCents;
        if (a.marginPct === null) return 1;
        if (b.marginPct === null) return -1;
        return b.marginPct - a.marginPct || b.grossProfitCents - a.grossProfitCents;
      default:
        return b.grossProfitCents - a.grossProfitCents || b.revenueCents - a.revenueCents;
    }
  });

  return {
    // Totals over EVERY row, before the cap — see the note on `limit`.
    rows: limit > 0 ? sorted.slice(0, limit) : sorted,
    totalRevenueCents: rows.reduce((sum, row) => sum + row.revenueCents, 0),
    totalCostCents: rows.reduce((sum, row) => sum + row.costCents, 0),
    totalGrossProfitCents: rows.reduce((sum, row) => sum + row.grossProfitCents, 0),
    uncostedUnits: rows.reduce((sum, row) => sum + row.uncostedUnits, 0),
  };
}
