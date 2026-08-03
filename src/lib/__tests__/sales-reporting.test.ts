import {
  bucketDailyTotals,
  costOfGoodsSold,
  grossSalesCents,
  netRevenueCents,
  refundedCents,
  taxCollectedCents,
  type PeriodRefund,
} from '@/lib/sales-reporting';
import type { Sale, SaleItem } from '@/types/models';

function makeItem(overrides: Partial<SaleItem> = {}): SaleItem {
  return {
    id: 'i1',
    saleId: 's1',
    productId: 'p1',
    productName: 'ANUA Heartleaf Toner',
    unitPriceCents: 2200,
    quantity: 1,
    lineTotalCents: 2200,
    discountCents: 0,
    unitCostCents: 1200,
    ...overrides,
  };
}

function makeSale(overrides: Partial<Sale> = {}): Sale {
  return {
    id: 's1',
    shopId: 'shop1',
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
    totalCents: 2200,
    itemCount: 1,
    createdAt: new Date(2026, 7, 2, 12, 0, 0).toISOString(),
    items: [makeItem()],
    payments: [],
    edits: [],
    refunds: [],
    ...overrides,
  };
}

function makeRefund(overrides: Partial<PeriodRefund> = {}): PeriodRefund {
  return {
    id: 'r1',
    createdAt: new Date(2026, 7, 3, 12, 0, 0).toISOString(),
    totalCents: 2200,
    items: [{ quantity: 1, unitCostCents: 1200 }],
    ...overrides,
  };
}

describe('revenue is reported net of tax', () => {
  // The correction this module exists for: sales.total_cents includes the
  // sales tax collected, which is a liability owed onward, not the shop's
  // money. Reporting it as revenue overstates both revenue and profit.
  const taxed = makeSale({ totalCents: 2310, taxCents: 110 });

  it('separates gross takings from tax', () => {
    expect(grossSalesCents([taxed])).toBe(2310);
    expect(taxCollectedCents([taxed])).toBe(110);
  });

  it('excludes tax from revenue', () => {
    expect(netRevenueCents([taxed])).toBe(2200);
  });

  it('leaves revenue equal to takings when the shop charges no tax', () => {
    const untaxed = makeSale({ totalCents: 2200, taxCents: 0 });
    expect(netRevenueCents([untaxed])).toBe(2200);
  });
});

describe('revenue is reported net of refunds', () => {
  it('subtracts refunds from revenue', () => {
    const sales = [makeSale({ totalCents: 5000, taxCents: 0 })];
    expect(netRevenueCents(sales, [makeRefund({ totalCents: 2000 })])).toBe(3000);
  });

  it('nets a fully refunded sale to zero', () => {
    const sale = makeSale({ totalCents: 2200, taxCents: 0 });
    expect(netRevenueCents([sale], [makeRefund({ totalCents: 2200 })])).toBe(0);
  });

  it('can go negative when refunds exceed the period’s sales', () => {
    // A refund against an earlier period's sale genuinely makes this period
    // negative -- that's accurate, not a bug to clamp away.
    expect(netRevenueCents([], [makeRefund({ totalCents: 2200 })])).toBe(-2200);
  });

  it('sums multiple refunds', () => {
    expect(refundedCents([makeRefund({ id: 'a', totalCents: 1000 }), makeRefund({ id: 'b', totalCents: 500 })])).toBe(1500);
  });
});

describe('costOfGoodsSold', () => {
  it('uses the cost frozen on the line, times quantity', () => {
    const sale = makeSale({ items: [makeItem({ quantity: 3, unitCostCents: 1200 })] });
    expect(costOfGoodsSold([sale]).cogsCents).toBe(3600);
  });

  // Returned goods went back into stock, so their cost is no longer a cost of
  // sale -- without this, refunding leaves COGS overstated and profit understated.
  it('reverses cost for refunded quantities', () => {
    const sale = makeSale({ items: [makeItem({ quantity: 3, unitCostCents: 1200 })] });
    const refund = makeRefund({ items: [{ quantity: 1, unitCostCents: 1200 }] });
    expect(costOfGoodsSold([sale], [refund]).cogsCents).toBe(2400);
  });

  it('nets to zero when everything sold is refunded', () => {
    const sale = makeSale({ items: [makeItem({ quantity: 2, unitCostCents: 1200 })] });
    const refund = makeRefund({ items: [{ quantity: 2, unitCostCents: 1200 }] });
    expect(costOfGoodsSold([sale], [refund]).cogsCents).toBe(0);
  });

  // Valuing an unknown cost at zero would report a 100% margin on that line.
  // Counting it separately lets the report admit the gap instead.
  it('counts items with no recorded cost rather than valuing them at zero', () => {
    const sale = makeSale({
      items: [makeItem({ id: 'a', unitCostCents: 1200 }), makeItem({ id: 'b', unitCostCents: null, lineTotalCents: 3000 })],
    });
    const result = costOfGoodsSold([sale]);
    expect(result.cogsCents).toBe(1200);
    expect(result.uncostedItemCount).toBe(1);
    expect(result.uncostedRevenueCents).toBe(3000);
  });

  it('ignores a refund line whose original cost is unknown', () => {
    const sale = makeSale({ items: [makeItem({ unitCostCents: null, lineTotalCents: 2200 })] });
    const refund = makeRefund({ items: [{ quantity: 1, unitCostCents: null }] });
    expect(costOfGoodsSold([sale], [refund]).cogsCents).toBe(0);
  });

  it('reports nothing for a period with no sales', () => {
    expect(costOfGoodsSold([])).toEqual({ cogsCents: 0, uncostedItemCount: 0, uncostedRevenueCents: 0 });
  });
});

describe('bucketDailyTotals', () => {
  const since = new Date(2026, 7, 1);
  const until = new Date(2026, 7, 3);

  it('emits one bucket per day including days with no sales', () => {
    const buckets = bucketDailyTotals([], [], since, until);
    expect(buckets).toHaveLength(3);
    expect(buckets.every((b) => b.netRevenueCents === 0)).toBe(true);
  });

  it('files each sale under its own day, net of tax', () => {
    const sales = [
      makeSale({ id: 'a', createdAt: new Date(2026, 7, 1, 9, 0).toISOString(), totalCents: 2310, taxCents: 110 }),
      makeSale({ id: 'b', createdAt: new Date(2026, 7, 3, 9, 0).toISOString(), totalCents: 1050, taxCents: 50 }),
    ];
    const buckets = bucketDailyTotals(sales, [], since, until);
    expect(buckets[0].netRevenueCents).toBe(2200);
    expect(buckets[0].grossCents).toBe(2310);
    expect(buckets[0].taxCents).toBe(110);
    expect(buckets[1].netRevenueCents).toBe(0);
    expect(buckets[2].netRevenueCents).toBe(1000);
  });

  // A refund is booked on the day it happened, not the day of the original
  // sale, so a closed period's reported revenue never changes after the fact.
  it('files a refund under the day it happened', () => {
    const sales = [makeSale({ createdAt: new Date(2026, 7, 1, 9, 0).toISOString(), totalCents: 2200, taxCents: 0 })];
    const refunds = [makeRefund({ createdAt: new Date(2026, 7, 3, 9, 0).toISOString(), totalCents: 2200 })];
    const buckets = bucketDailyTotals(sales, refunds, since, until);
    expect(buckets[0].netRevenueCents).toBe(2200);
    expect(buckets[2].netRevenueCents).toBe(-2200);
    expect(buckets[2].refundCents).toBe(2200);
  });

  it('counts orders and rolls up line-level discounts', () => {
    const sales = [
      makeSale({
        createdAt: new Date(2026, 7, 1, 9, 0).toISOString(),
        discountCents: 100,
        items: [makeItem({ discountCents: 50 }), makeItem({ id: 'i2', discountCents: 25 })],
      }),
    ];
    const buckets = bucketDailyTotals(sales, [], since, until);
    expect(buckets[0].orderCount).toBe(1);
    expect(buckets[0].discountCents).toBe(175);
  });

  it('drops activity outside the range rather than misfiling it', () => {
    const sales = [makeSale({ createdAt: new Date(2026, 6, 20, 9, 0).toISOString(), totalCents: 9999 })];
    const buckets = bucketDailyTotals(sales, [], since, until);
    expect(buckets.every((b) => b.grossCents === 0)).toBe(true);
  });
});
