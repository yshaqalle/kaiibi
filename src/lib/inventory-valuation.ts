import type { Product } from '@/types/models';

// What the stock on the shelves is worth, and what it might sell for.
//
// Valued AT COST, not at the price tag, and this is the decision the whole
// report turns on. Stock is an asset because the shop paid for it; the profit
// on it has not been earned until someone buys it, and valuing inventory at
// retail books that profit in advance. It is also the single most common way
// a small business's balance sheet ends up overstated.
//
// Pure — the fetching is `listProducts` in products.ts. This is what the
// `inventory` feed reports on the balance sheet (see trial-balance.ts), so the
// figure here and the figure there cannot differ.

export type InventoryValuationRow = {
  productId: string;
  name: string;
  category: string | null;
  units: number;
  /** Null when nobody recorded what it cost. Not zero — see `uncosted` below. */
  unitCostCents: number | null;
  unitPriceCents: number;
  /** units × cost. Zero for an uncosted product, which `uncostedUnits` then reports separately. */
  atCostCents: number;
  /** units × price. What it would fetch if every unit sold at the current tag. */
  atRetailCents: number;
  /** Retail less cost — profit not yet earned. */
  potentialMarginCents: number;
  uncosted: boolean;
};

export type InventoryValuation = {
  rows: InventoryValuationRow[];
  /** The balance sheet's inventory figure. */
  totalAtCostCents: number;
  totalAtRetailCents: number;
  potentialMarginCents: number;
  totalUnits: number;
  /**
   * Units of stock nobody recorded a cost for.
   *
   * Reported rather than valued at zero, and reported in UNITS rather than as
   * a count of products: 400 uncosted bottles understate the balance sheet far
   * more than four uncosted display cabinets, and a product count cannot tell
   * a reader which they are looking at. `costOfGoodsSold` in sales-reporting.ts
   * draws the same line for the same reason.
   */
  uncostedUnits: number;
  uncostedProductCount: number;
  /** Products with stock on hand. A catalogue entry at zero is not inventory. */
  stockedProductCount: number;
};

/**
 * Values whatever products it is handed.
 *
 * Negative stock is counted as it stands rather than clamped to zero. It is a
 * real state -- a sale rung up before a delivery was received -- and clamping
 * would quietly value the shelf higher than the shop's own count does, which
 * is the opposite of what a valuation report is for.
 */
export function valueInventory(products: Product[]): InventoryValuation {
  const rows: InventoryValuationRow[] = products
    .filter((product) => product.stock !== 0)
    .map((product) => {
      const uncosted = product.costCents === null;
      const atCostCents = uncosted ? 0 : product.stock * (product.costCents ?? 0);
      const atRetailCents = product.stock * product.priceCents;
      return {
        productId: product.id,
        name: product.name,
        category: product.category,
        units: product.stock,
        unitCostCents: product.costCents,
        unitPriceCents: product.priceCents,
        atCostCents,
        atRetailCents,
        // An uncosted product has no known margin, and calling the whole
        // retail value "margin" would report a 100% markup on it.
        potentialMarginCents: uncosted ? 0 : atRetailCents - atCostCents,
        uncosted,
      };
    })
    // Most valuable first: the reader is checking whether the big numbers look
    // right, and a report ordered by name buries them.
    .sort((a, b) => b.atCostCents - a.atCostCents || b.atRetailCents - a.atRetailCents);

  return {
    rows,
    totalAtCostCents: rows.reduce((sum, row) => sum + row.atCostCents, 0),
    totalAtRetailCents: rows.reduce((sum, row) => sum + row.atRetailCents, 0),
    potentialMarginCents: rows.reduce((sum, row) => sum + row.potentialMarginCents, 0),
    totalUnits: rows.reduce((sum, row) => sum + row.units, 0),
    uncostedUnits: rows.filter((row) => row.uncosted).reduce((sum, row) => sum + row.units, 0),
    uncostedProductCount: rows.filter((row) => row.uncosted).length,
    stockedProductCount: rows.length,
  };
}

export type InventoryCategoryTotal = {
  category: string;
  atCostCents: number;
  units: number;
  productCount: number;
};

/** The same valuation grouped by category, biggest first. */
export function valuationByCategory(valuation: InventoryValuation): InventoryCategoryTotal[] {
  const totals = new Map<string, InventoryCategoryTotal>();
  for (const row of valuation.rows) {
    // A blank category is a real group, not a missing one: "Uncategorised" is
    // what the shop will search for when they go to fix it.
    const category = row.category?.trim() || 'Uncategorised';
    const existing = totals.get(category);
    if (existing) {
      existing.atCostCents += row.atCostCents;
      existing.units += row.units;
      existing.productCount += 1;
    } else {
      totals.set(category, { category, atCostCents: row.atCostCents, units: row.units, productCount: 1 });
    }
  }
  return [...totals.values()].sort((a, b) => b.atCostCents - a.atCostCents || a.category.localeCompare(b.category));
}
