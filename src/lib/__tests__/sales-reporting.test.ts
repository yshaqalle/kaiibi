import {
  bucketDailyTotals,
  cashierPerformance,
  costOfGoodsSold,
  hourlyTakings,
  grossSalesCents,
  netRevenueCents,
  paymentMethodMix,
  productMovers,
  productPerformance,
  refundedCents,
  refundPreviewCents,
  saleProfit,
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

describe('saleProfit', () => {
  // The per-transaction view of the same arithmetic the period totals use, so
  // a shopkeeper can see which sales actually made money rather than only
  // which ones were large.
  it('is revenue less the cost frozen on each line', () => {
    const sale = makeSale({
      totalCents: 2200,
      items: [makeItem({ quantity: 1, unitPriceCents: 2200, lineTotalCents: 2200, unitCostCents: 1200 })],
    });
    const result = saleProfit(sale);
    expect(result.netRevenueCents).toBe(2200);
    expect(result.costCents).toBe(1200);
    expect(result.profitCents).toBe(1000);
    expect(result.marginPercent).toBeCloseTo(45.45, 2);
  });

  // Tax is collected on the authority's behalf. Counting it as revenue would
  // inflate the profit on every sale in a tax-enabled shop.
  it('excludes sales tax from revenue', () => {
    const sale = makeSale({
      totalCents: 2310,
      taxCents: 110,
      items: [makeItem({ unitCostCents: 1200 })],
    });
    const result = saleProfit(sale);
    expect(result.netRevenueCents).toBe(2200);
    expect(result.profitCents).toBe(1000);
  });

  // A sale-level discount is already inside totalCents, so profit follows it
  // down without the discount having to be subtracted a second time.
  it('reflects a sale-level discount through the total', () => {
    const sale = makeSale({
      totalCents: 4950,
      discountCents: 1650,
      items: [
        makeItem({ id: 'a', unitPriceCents: 2500, lineTotalCents: 2500, unitCostCents: 1500 }),
        makeItem({ id: 'b', unitPriceCents: 2200, lineTotalCents: 2200, unitCostCents: 1300 }),
        makeItem({ id: 'c', unitPriceCents: 1900, lineTotalCents: 1900, unitCostCents: 1000 }),
      ],
    });
    const result = saleProfit(sale);
    expect(result.netRevenueCents).toBe(4950);
    expect(result.costCents).toBe(3800);
    expect(result.profitCents).toBe(1150);
  });

  // Refunded goods came back into stock: both their revenue and their cost
  // have to come out, or a fully refunded sale still shows a profit.
  it('nets out refunded revenue and the cost of returned goods', () => {
    const sale = makeSale({
      totalCents: 4400,
      items: [makeItem({ id: 'a', quantity: 2, lineTotalCents: 4400, unitCostCents: 1200 })],
      refunds: [
        {
          id: 'r1',
          saleId: 's1',
          refundedBy: null,
          totalCents: 2200,
          createdAt: new Date(2026, 7, 3).toISOString(),
          items: [{ id: 'ri1', refundId: 'r1', saleItemId: 'a', productId: 'p1', quantity: 1, amountCents: 2200 }],
        },
      ],
    });
    const result = saleProfit(sale);
    expect(result.netRevenueCents).toBe(2200);
    expect(result.costCents).toBe(1200);
    expect(result.profitCents).toBe(1000);
  });

  it('nets to zero when the whole sale is refunded', () => {
    const sale = makeSale({
      totalCents: 2200,
      items: [makeItem({ id: 'a', quantity: 1, lineTotalCents: 2200, unitCostCents: 1200 })],
      refunds: [
        {
          id: 'r1',
          saleId: 's1',
          refundedBy: null,
          totalCents: 2200,
          createdAt: new Date(2026, 7, 3).toISOString(),
          items: [{ id: 'ri1', refundId: 'r1', saleItemId: 'a', productId: 'p1', quantity: 1, amountCents: 2200 }],
        },
      ],
    });
    const result = saleProfit(sale);
    expect(result.netRevenueCents).toBe(0);
    expect(result.costCents).toBe(0);
    expect(result.profitCents).toBe(0);
    expect(result.marginPercent).toBeNull();
  });

  // The number has to admit what it doesn't know. Treating an unknown cost as
  // zero would show this sale as pure profit.
  it('flags lines with no cost on file instead of valuing them at zero', () => {
    const sale = makeSale({
      totalCents: 5200,
      items: [
        makeItem({ id: 'a', lineTotalCents: 2200, unitCostCents: 1200 }),
        makeItem({ id: 'b', lineTotalCents: 3000, unitCostCents: null }),
      ],
    });
    const result = saleProfit(sale);
    expect(result.costCents).toBe(1200);
    expect(result.uncostedItemCount).toBe(1);
    expect(result.uncostedRevenueCents).toBe(3000);
  });

  it('does not flag a line whose refunded quantity leaves nothing sold', () => {
    const sale = makeSale({
      totalCents: 3000,
      items: [makeItem({ id: 'b', quantity: 1, lineTotalCents: 3000, unitCostCents: null })],
      refunds: [
        {
          id: 'r1',
          saleId: 's1',
          refundedBy: null,
          totalCents: 3000,
          createdAt: new Date(2026, 7, 3).toISOString(),
          items: [{ id: 'ri1', refundId: 'r1', saleItemId: 'b', productId: 'p1', quantity: 1, amountCents: 3000 }],
        },
      ],
    });
    expect(saleProfit(sale).uncostedItemCount).toBe(0);
  });

  it('reports no margin for a sale that earned nothing', () => {
    const sale = makeSale({ totalCents: 0, items: [] });
    expect(saleProfit(sale).marginPercent).toBeNull();
  });
});

describe('cashierPerformance', () => {
  it('totals takings per cashier, biggest first', () => {
    const sales = [
      makeSale({ id: 'a', cashierName: 'Hodan', totalCents: 5000 }),
      makeSale({ id: 'b', cashierName: 'Amran', totalCents: 9000 }),
      makeSale({ id: 'c', cashierName: 'Hodan', totalCents: 1000 }),
    ];
    expect(cashierPerformance(sales)).toEqual([
      { name: 'Amran', revenueCents: 9000 },
      { name: 'Hodan', revenueCents: 6000 },
    ]);
  });

  it('skips sales with no cashier recorded', () => {
    expect(cashierPerformance([makeSale({ cashierName: null })])).toEqual([]);
  });
});

describe('paymentMethodMix', () => {
  it('splits takings across the payment lines', () => {
    const sale = makeSale({
      totalCents: 10000,
      payments: [
        { id: 'p1', saleId: 's1', method: 'cash', amountCents: 6000, tenderedCents: null, customerName: null, customerPhone: null, currencyCode: null, exchangeRate: null, foreignAmountCents: null, foreignChangeCents: null, createdAt: '' },
        { id: 'p2', saleId: 's1', method: 'zaad', amountCents: 4000, tenderedCents: null, customerName: null, customerPhone: null, currencyCode: null, exchangeRate: null, foreignAmountCents: null, foreignChangeCents: null, createdAt: '' },
      ],
    });
    const mix = paymentMethodMix([sale]);
    expect(mix).toEqual([
      { method: 'cash', amountCents: 6000, pct: 60 },
      { method: 'zaad', amountCents: 4000, pct: 40 },
    ]);
  });

  // Sales predating split payments carry the method on the sale itself;
  // dropping them would silently under-report the mix.
  it('falls back to the sale’s own method when it has no payment lines', () => {
    const mix = paymentMethodMix([makeSale({ paymentMethod: 'edahab', totalCents: 2500, payments: [] })]);
    expect(mix).toEqual([{ method: 'edahab', amountCents: 2500, pct: 100 }]);
  });

  it('does not divide by zero for a period with no takings', () => {
    expect(paymentMethodMix([])).toEqual([]);
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

// The figures here are the same ones verify-refunds.sql asserts against the
// real database. If these two ever drift, the cashier is being quoted a number
// the server will not pay.
describe('refundPreviewCents', () => {
  const soap = (overrides: Partial<SaleItem> = {}) =>
    makeItem({ id: 'i1', unitPriceCents: 1999, quantity: 1, lineTotalCents: 1999, ...overrides });

  it('returns the price on a plain sale', () => {
    const sale = makeSale({ items: [soap()], totalCents: 1999, taxCents: 0 });
    expect(refundPreviewCents(sale, { i1: 1 })).toBe(1999);
  });

  it('does not hand back an order discount a second time', () => {
    // 1999 of goods, 200 off, so 1799 was paid — the old maths quoted 1999.
    const sale = makeSale({ items: [soap()], totalCents: 1799, discountCents: 200, taxCents: 0 });
    expect(refundPreviewCents(sale, { i1: 1 })).toBe(1799);
  });

  it('includes tax, which is not in a line total at all', () => {
    const sale = makeSale({ items: [soap()], totalCents: 2099, taxCents: 100 });
    expect(refundPreviewCents(sale, { i1: 1 })).toBe(2099);
  });

  it('does not turn redeemed points into cash', () => {
    const sale = makeSale({ items: [soap()], totalCents: 1949, pointsRedeemed: 50, pointsRedeemedCents: 50 });
    expect(refundPreviewCents(sale, { i1: 1 })).toBe(1949);
  });

  it('returns nothing when nothing is selected', () => {
    const sale = makeSale({ items: [soap()], totalCents: 1999 });
    expect(refundPreviewCents(sale, {})).toBe(0);
  });

  it('nets off what earlier refunds already handed back', () => {
    // Three units at 5997 gross, 300 off, 285 tax, 5982 paid. One already back.
    const sale = makeSale({
      items: [soap({ quantity: 3, lineTotalCents: 5997 })],
      totalCents: 5982,
      discountCents: 300,
      taxCents: 285,
      refunds: [{ id: 'r1', saleId: 's1', refundedBy: null, totalCents: 1994, createdAt: '', items: [{ id: 'ri1', refundId: 'r1', saleItemId: 'i1', productId: 'p1', quantity: 1, amountCents: 1994 }] }],
    });
    expect(refundPreviewCents(sale, { i1: 2 })).toBe(5982 - 1994);
  });

  it('never goes negative on a sale already over-refunded under the old maths', () => {
    const sale = makeSale({
      items: [soap({ quantity: 2, lineTotalCents: 3998 })],
      totalCents: 3598,
      discountCents: 400,
      refunds: [{ id: 'r1', saleId: 's1', refundedBy: null, totalCents: 1999, createdAt: '', items: [{ id: 'ri1', refundId: 'r1', saleItemId: 'i1', productId: 'p1', quantity: 1, amountCents: 1999 }] }],
    });
    expect(refundPreviewCents(sale, { i1: 1 })).toBeGreaterThanOrEqual(0);
  });

  it('returns 0 rather than dividing by zero when every line is free', () => {
    const sale = makeSale({ items: [soap({ lineTotalCents: 0 })], totalCents: 0 });
    expect(refundPreviewCents(sale, { i1: 1 })).toBe(0);
  });
});

describe('productPerformance', () => {
  const rice = () => makeItem({ id: 'i-rice', productId: 'p-rice', productName: 'Basmati Rice 5kg', quantity: 2, lineTotalCents: 2300 });
  const oil = () => makeItem({ id: 'i-oil', productId: 'p-oil', productName: 'Cooking Oil 3L', quantity: 1, lineTotalCents: 1450 });

  it('sums units and money per product across sales', () => {
    const rows = productPerformance([
      makeSale({ id: 's1', items: [rice(), oil()] }),
      makeSale({ id: 's2', items: [rice()] }),
    ]);
    expect(rows).toEqual([
      { productId: 'p-rice', name: 'Basmati Rice 5kg', unitsSold: 4, revenueCents: 4600 },
      { productId: 'p-oil', name: 'Cooking Oil 3L', unitsSold: 1, revenueCents: 1450 },
    ]);
  });

  it('ranks by money, which can disagree with ranking by units', () => {
    // The whole reason the card is sortable: sugar outsells rice by unit and
    // loses to it by revenue.
    const sugar = makeItem({ id: 'i-sugar', productId: 'p-sugar', productName: 'Sugar 2kg', quantity: 20, lineTotalCents: 1000 });
    const rows = productPerformance([makeSale({ items: [rice(), sugar] })]);
    expect(rows.map((r) => r.name)).toEqual(['Basmati Rice 5kg', 'Sugar 2kg']);
    expect(rows.map((r) => r.unitsSold)).toEqual([2, 20]);
  });

  it('keeps two deleted products apart even when they share a name', () => {
    // productId is null once a product is deleted; folding those together
    // would merge two unrelated lines under one heading.
    const rows = productPerformance([
      makeSale({
        items: [
          makeItem({ id: 'a', productId: null, productName: 'Sugar', lineTotalCents: 100, quantity: 1 }),
          makeItem({ id: 'b', productId: 'p-sugar', productName: 'Sugar', lineTotalCents: 500, quantity: 1 }),
        ],
      }),
    ]);
    expect(rows).toHaveLength(2);
  });

  it('ignores sales whose items were never loaded', () => {
    expect(productPerformance([makeSale({ items: undefined })])).toEqual([]);
  });

  it('honours the limit', () => {
    const many = [1, 2, 3, 4].map((n) =>
      makeItem({ id: `i${n}`, productId: `p${n}`, productName: `P${n}`, quantity: 1, lineTotalCents: n * 100 })
    );
    expect(productPerformance([makeSale({ items: many })], 2).map((r) => r.name)).toEqual(['P4', 'P3']);
  });
});

describe('productMovers', () => {
  const row = (name: string, revenueCents: number, unitsSold = 1) => ({ productId: name, name, unitsSold, revenueCents });

  it('ranks by the size of the change, not by the size of the product', () => {
    const current = [row('Rice', 10_000), row('Oil', 5_000)];
    const previous = [row('Rice', 9_500), row('Oil', 2_500)];
    // Rice is twice the product; Oil is the mover.
    expect(productMovers(current, previous).map((m) => m.name)).toEqual(['Oil', 'Rice']);
  });

  it('reports a fall as a fall', () => {
    const movers = productMovers([row('Milk', 4_000)], [row('Milk', 8_000)]);
    expect(movers[0].changePct).toBeCloseTo(-50);
  });

  it('drops products too small to be news', () => {
    // A 400% jump on 1% of takings is noise. The floor is a share of the
    // period's revenue, not an absolute figure, so it travels between shops.
    const current = [row('Rice', 99_000), row('Chewing gum', 1_000)];
    const previous = [row('Rice', 90_000), row('Chewing gum', 200)];
    expect(productMovers(current, previous).map((m) => m.name)).toEqual(['Rice']);
  });

  it('marks a product with no prior sales as new rather than as an infinite rise', () => {
    const movers = productMovers([row('Rice', 5_000)], []);
    expect(movers[0].changePct).toBeNull();
    expect(movers[0].previousCents).toBe(0);
  });

  it('sorts products with a measured change ahead of brand new ones', () => {
    const current = [row('Rice', 5_000), row('Oil', 5_000)];
    const previous = [row('Rice', 4_000)];
    expect(productMovers(current, previous).map((m) => m.name)).toEqual(['Rice', 'Oil']);
  });

  it('returns nothing when there is no prior window to compare against', () => {
    expect(productMovers([row('Rice', 5_000)], [], { hasPrevious: false })).toEqual([]);
  });
});

describe('hourlyTakings', () => {
  const at = (hour: number, totalCents: number) =>
    makeSale({ id: `s${hour}-${totalCents}`, totalCents, createdAt: new Date(2026, 7, 2, hour, 30).toISOString() });

  it('gives one bucket per open hour, including the quiet ones', () => {
    const { buckets } = hourlyTakings([at(9, 500)], 8, 11);
    expect(buckets.map((b) => b.hour)).toEqual([8, 9, 10, 11]);
    expect(buckets.map((b) => b.grossCents)).toEqual([0, 500, 0, 0]);
  });

  it('counts orders alongside the money', () => {
    const { buckets } = hourlyTakings([at(9, 500), at(9, 700)], 8, 10);
    expect(buckets[1]).toMatchObject({ hour: 9, grossCents: 1200, orderCount: 2 });
  });

  it('keeps out-of-hours takings in the chart and reports them separately', () => {
    // A sale rung up before opening is real money. Dropping it makes the
    // chart disagree with the P&L; silently folding it in hides that the
    // shop traded outside its posted hours.
    const { buckets, outsideCents } = hourlyTakings([at(6, 900), at(23, 400)], 8, 20);
    expect(outsideCents).toBe(1300);
    expect(buckets[0]).toMatchObject({ hour: 8, grossCents: 900 });
    expect(buckets[buckets.length - 1]).toMatchObject({ hour: 20, grossCents: 400 });
    expect(buckets.reduce((sum, b) => sum + b.grossCents, 0)).toBe(1300);
  });

  it('survives a close hour before the open hour', () => {
    expect(hourlyTakings([], 20, 8).buckets).toEqual([]);
  });
});
