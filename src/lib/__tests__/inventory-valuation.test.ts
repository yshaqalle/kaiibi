import { valuationByCategory, valueInventory } from '@/lib/inventory-valuation';
import type { Product } from '@/types/models';

function product(overrides: Partial<Product> = {}): Product {
  return {
    id: 'p1',
    shopId: 'shop',
    name: 'Shea butter 200ml',
    description: null,
    sku: null,
    barcode: null,
    brand: null,
    category: 'Skincare',
    tags: [],
    supplierName: null,
    costCents: 400,
    priceCents: 1_000,
    stock: 10,
    reorderLevel: null,
    shelfNumber: null,
    expiryDate: null,
    batchNumber: null,
    imageUrl: null,
    isListedOnline: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('valueInventory', () => {
  it('values stock at what it cost, not at the price tag', () => {
    // Valuing at retail books the profit before anyone has bought anything —
    // the commonest way a small business overstates its balance sheet.
    const valuation = valueInventory([product()]);
    expect(valuation.totalAtCostCents).toBe(4_000);
    expect(valuation.totalAtRetailCents).toBe(10_000);
    expect(valuation.potentialMarginCents).toBe(6_000);
  });

  it('leaves a product with no stock out entirely', () => {
    // A catalogue entry at zero is not inventory.
    const valuation = valueInventory([product({ stock: 0 })]);
    expect(valuation.rows).toHaveLength(0);
    expect(valuation.stockedProductCount).toBe(0);
  });

  it('reports uncosted stock in UNITS rather than valuing it at zero', () => {
    // 400 uncosted bottles understate the balance sheet far more than four
    // uncosted cabinets, and a product count cannot tell those apart.
    const valuation = valueInventory([product({ costCents: null, stock: 400 })]);
    expect(valuation.totalAtCostCents).toBe(0);
    expect(valuation.uncostedUnits).toBe(400);
    expect(valuation.uncostedProductCount).toBe(1);
    // No known cost means no known margin — calling the whole retail value
    // margin would claim a 100% markup.
    expect(valuation.potentialMarginCents).toBe(0);
  });

  it('treats a cost of zero as a real answer, not a missing one', () => {
    // A free sample or a gift with purchase genuinely cost nothing.
    const valuation = valueInventory([product({ costCents: 0 })]);
    expect(valuation.uncostedUnits).toBe(0);
    expect(valuation.potentialMarginCents).toBe(10_000);
  });

  it('counts negative stock as it stands rather than clamping it', () => {
    // A sale rung up before a delivery was received is a real state, and
    // clamping would value the shelf higher than the shop's own count does.
    const valuation = valueInventory([product({ stock: -3 })]);
    expect(valuation.totalUnits).toBe(-3);
    expect(valuation.totalAtCostCents).toBe(-1_200);
  });

  it('lists the most valuable first — the figures a reader is checking', () => {
    const valuation = valueInventory([
      product({ id: 'cheap', name: 'Cheap', costCents: 100, stock: 1 }),
      product({ id: 'dear', name: 'Dear', costCents: 5_000, stock: 4 }),
    ]);
    expect(valuation.rows.map((row) => row.productId)).toEqual(['dear', 'cheap']);
  });
});

describe('valuationByCategory', () => {
  it('groups by category, biggest first', () => {
    const valuation = valueInventory([
      product({ id: 'a', category: 'Skincare', costCents: 400, stock: 10 }),
      product({ id: 'b', category: 'Haircare', costCents: 900, stock: 10 }),
      product({ id: 'c', category: 'Skincare', costCents: 100, stock: 10 }),
    ]);
    const groups = valuationByCategory(valuation);
    expect(groups.map((group) => group.category)).toEqual(['Haircare', 'Skincare']);
    expect(groups[1].atCostCents).toBe(5_000);
    expect(groups[1].productCount).toBe(2);
  });

  it('treats a blank category as a real group somebody can go and fix', () => {
    const valuation = valueInventory([product({ category: '  ' })]);
    expect(valuationByCategory(valuation)[0].category).toBe('Uncategorised');
  });
});
