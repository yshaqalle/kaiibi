import { itemPerformance } from '@/lib/item-performance';
import type { Sale, SaleItem } from '@/types/models';

// The ranking a shop reorders off. Revenue is the intuitive sort and the wrong
// one: a $40 bottle bought for $37 earns less than four $3 packets bought for
// $1, so a shop ordering off a revenue list keeps buying its worst stock.

function makeItem(overrides: Partial<SaleItem> = {}): SaleItem {
  return {
    id: 'i1',
    saleId: 's1',
    productId: 'p1',
    productName: 'Toner',
    unitPriceCents: 2_200,
    quantity: 1,
    lineTotalCents: 2_200,
    discountCents: 0,
    unitCostCents: 1_200,
    promotionId: null,
    promotionName: null,
    ...overrides,
  };
}

function makeSale(overrides: Partial<Sale> = {}): Sale {
  return {
    id: 's1',
    shopId: 'shop1',
    locationId: 'loc1',
    createdBy: null,
    paymentMethod: 'cash',
    paymentNote: null,
    customerName: null,
    customerPhone: null,
    customerEmail: null,
    customerId: null,
    cashierName: null,
    discountCents: 0,
    taxCents: 0,
    taxRatePercent: null,
    pointsEarned: 0,
    pointsRedeemed: 0,
    pointsRedeemedCents: 0,
    loyaltyPointsPerUsd: null,
    totalCents: 2_200,
    itemCount: 1,
    createdAt: new Date(2026, 7, 2, 12, 0, 0).toISOString(),
    items: [makeItem()],
    payments: [],
    edits: [],
    refunds: [],
    ...overrides,
  };
}

describe('itemPerformance', () => {
  it('reports revenue, cost and the profit left over', () => {
    const result = itemPerformance([makeSale()]);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].revenueCents).toBe(2_200);
    expect(result.rows[0].costCents).toBe(1_200);
    expect(result.rows[0].grossProfitCents).toBe(1_000);
    expect(result.rows[0].marginPct).toBe(45);
    expect(result.rows[0].averagePriceCents).toBe(2_200);
  });

  it('adds up the same product across sales', () => {
    const result = itemPerformance([makeSale(), makeSale({ id: 's2' })]);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].unitsSold).toBe(2);
    expect(result.totalGrossProfitCents).toBe(2_000);
  });

  it('ranks by profit by default, not by revenue', () => {
    const bottle = makeSale({
      id: 'bottle',
      items: [makeItem({ id: 'b', productId: 'bottle', productName: 'Bottle', lineTotalCents: 4_000, unitCostCents: 3_700 })],
    });
    const packets = makeSale({
      id: 'packets',
      items: [
        makeItem({
          id: 'p',
          productId: 'packet',
          productName: 'Packet',
          quantity: 4,
          lineTotalCents: 1_200,
          unitCostCents: 100,
        }),
      ],
    });
    // The bottle brings in more money; the packets make more money.
    expect(itemPerformance([bottle, packets]).rows.map((row) => row.productId)).toEqual(['packet', 'bottle']);
    expect(itemPerformance([bottle, packets], { sort: 'revenue' }).rows.map((row) => row.productId)).toEqual([
      'bottle',
      'packet',
    ]);
  });

  it('states no margin at all for a product whose cost was never recorded', () => {
    // Printing 0% would say the shop got the goods free and rank it last on a
    // margin sort — an unknown is not a bad result.
    const result = itemPerformance([
      makeSale({ items: [makeItem({ unitCostCents: null })] }),
    ]);
    expect(result.rows[0].marginPct).toBeNull();
    expect(result.rows[0].uncostedUnits).toBe(1);
    expect(result.uncostedUnits).toBe(1);
  });

  it('sorts unknown margins last rather than treating them as zero', () => {
    const known = makeSale({ id: 'k', items: [makeItem({ id: 'k', productId: 'known', productName: 'Known' })] });
    const unknown = makeSale({
      id: 'u',
      items: [makeItem({ id: 'u', productId: 'unknown', productName: 'Unknown', unitCostCents: null })],
    });
    expect(itemPerformance([known, unknown], { sort: 'margin' }).rows.map((row) => row.productId)).toEqual([
      'known',
      'unknown',
    ]);
  });

  it('is net of returns', () => {
    const sale = makeSale({
      items: [makeItem({ quantity: 4, lineTotalCents: 8_800 })],
      refunds: [
        {
          id: 'r1',
          saleId: 's1',
          refundedBy: null,
          createdAt: new Date(2026, 7, 3).toISOString(),
          totalCents: 2_200,
          goodsCents: 2_200,
          items: [{ id: 'ri1', refundId: 'r1', saleItemId: 'i1', productId: 'p1', quantity: 1, amountCents: 2_200 }],
        },
      ],
    });
    const result = itemPerformance([sale]);
    expect(result.rows[0].unitsSold).toBe(3);
    expect(result.rows[0].revenueCents).toBe(6_600);
  });

  it('totals over everything, not just the rows a limit kept', () => {
    // A top-ten whose totals only add up the top ten reports a shop that sold
    // far less than it did.
    const sales = [1, 2, 3].map((n) =>
      makeSale({
        id: `s${n}`,
        items: [makeItem({ id: `i${n}`, productId: `p${n}`, productName: `Product ${n}` })],
      })
    );
    const result = itemPerformance(sales, { limit: 1 });
    expect(result.rows).toHaveLength(1);
    expect(result.totalRevenueCents).toBe(6_600);
  });

  it('keeps two deleted products apart rather than folding them by name', () => {
    const first = makeSale({ id: 'a', items: [makeItem({ id: 'a', productId: null, productName: 'Gone' })] });
    const second = makeSale({ id: 'b', items: [makeItem({ id: 'b', productId: null, productName: 'Also gone' })] });
    expect(itemPerformance([first, second]).rows).toHaveLength(2);
  });
});
