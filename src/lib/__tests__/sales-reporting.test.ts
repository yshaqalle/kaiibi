import {
  bucketDailyTotals,
  cashierPerformance,
  costOfGoodsSold,
  hourlyTakings,
  grossSalesCents,
  keptSpendCents,
  netRevenueCents,
  netTaxCollectedCents,
  paymentMethodMix,
  productDailyRevenue,
  productMovers,
  productPerformance,
  refundedCents,
  refundedTaxCents,
  refundPreviewCents,
  saleProfit,
  saleRefundState,
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
    saleTotalCents: 2200,
    saleTaxCents: 0,
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

  // Since migration 20260820000200 a refund hands back what the customer
  // actually PAID, tax included. Revenue here is already net of tax, so
  // subtracting the paid figure whole takes the tax out a second time and
  // leaves a fully refunded sale sitting at minus its own tax.
  it('subtracts only the pre-tax share of a refund, not the tax handed back with it', () => {
    const sale = makeSale({ totalCents: 2310, taxCents: 110 });
    const refund = makeRefund({ totalCents: 2310, saleTotalCents: 2310, saleTaxCents: 110 });
    expect(netRevenueCents([sale], [refund])).toBe(0);
  });

  it('subtracts the pre-tax share of a partial refund', () => {
    const sale = makeSale({ totalCents: 2310, taxCents: 110 });
    const refund = makeRefund({ totalCents: 1155, saleTotalCents: 2310, saleTaxCents: 110 });
    expect(netRevenueCents([sale], [refund])).toBe(1100);
  });
});

// Refunding a sale hands the tax back with it. That tax is no longer owed
// onward, so a liability figure that ignores refunds overstates what the shop
// has to remit -- a fully refunded sale would still claim its tax is being
// held for the authority.
describe('sales tax owed is net of what went back', () => {
  it('reports the tax handed back with refunds', () => {
    const refunds = [
      makeRefund({ id: 'a', totalCents: 2310, saleTotalCents: 2310, saleTaxCents: 110 }),
      makeRefund({ id: 'b', totalCents: 1050, saleTotalCents: 1050, saleTaxCents: 50 }),
    ];
    expect(refundedTaxCents(refunds)).toBe(160);
  });

  it('reports no refunded tax for a shop that charges none', () => {
    expect(refundedTaxCents([makeRefund({ totalCents: 2200, saleTotalCents: 2200, saleTaxCents: 0 })])).toBe(0);
  });

  it('nets a fully refunded sale to owing nothing', () => {
    const sale = makeSale({ totalCents: 2310, taxCents: 110 });
    const refund = makeRefund({ totalCents: 2310, saleTotalCents: 2310, saleTaxCents: 110 });
    expect(taxCollectedCents([sale])).toBe(110);
    expect(netTaxCollectedCents([sale], [refund])).toBe(0);
  });

  it('leaves the owed figure at what was collected when nothing came back', () => {
    expect(netTaxCollectedCents([makeSale({ totalCents: 2310, taxCents: 110 })], [])).toBe(110);
  });

  // Revenue must keep using the GROSS tax term. Netting refunded tax there too
  // would add it back into revenue, undoing the fix this all started with.
  it('does not let the netted tax figure leak into revenue', () => {
    const sale = makeSale({ totalCents: 2310, taxCents: 110 });
    const refund = makeRefund({ totalCents: 2310, saleTotalCents: 2310, saleTaxCents: 110 });
    expect(netRevenueCents([sale], [refund])).toBe(0);
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

  // A refund hands back what the customer PAID -- tax included -- since
  // migration 20260820000200. netRevenue is already net of tax, so subtracting
  // the paid figure whole removes the tax twice and lands a fully refunded
  // sale on minus its own tax. These are the real figures off a $12.60 line
  // taxed to $12.92, which reported -$0.32 revenue and -$0.32 profit.
  it('nets a fully refunded taxed sale to zero rather than to minus its tax', () => {
    const sale = makeSale({
      totalCents: 1292,
      taxCents: 32,
      items: [makeItem({ id: 'a', quantity: 1, unitPriceCents: 1260, lineTotalCents: 1260, unitCostCents: 500 })],
      refunds: [
        {
          id: 'r1',
          saleId: 's1',
          refundedBy: null,
          totalCents: 1292,
          createdAt: new Date(2026, 7, 3).toISOString(),
          items: [{ id: 'ri1', refundId: 'r1', saleItemId: 'a', productId: 'p1', quantity: 1, amountCents: 1292 }],
        },
      ],
    });
    const result = saleProfit(sale);
    expect(result.netRevenueCents).toBe(0);
    expect(result.costCents).toBe(0);
    expect(result.profitCents).toBe(0);
  });

  it('nets only the pre-tax share of a partial refund on a taxed sale', () => {
    const sale = makeSale({
      totalCents: 2310,
      taxCents: 110,
      items: [makeItem({ id: 'a', quantity: 2, unitPriceCents: 1100, lineTotalCents: 2200, unitCostCents: 600 })],
      refunds: [
        {
          id: 'r1',
          saleId: 's1',
          refundedBy: null,
          totalCents: 1155,
          createdAt: new Date(2026, 7, 3).toISOString(),
          items: [{ id: 'ri1', refundId: 'r1', saleItemId: 'a', productId: 'p1', quantity: 1, amountCents: 1155 }],
        },
      ],
    });
    const result = saleProfit(sale);
    expect(result.netRevenueCents).toBe(1100);
    expect(result.costCents).toBe(600);
    expect(result.profitCents).toBe(500);
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

  // The three figures the detail pane's Refunded block reconciles with:
  // paid, less what went back, leaves what the shop kept. Split out here
  // rather than recomputed in the component so the screen cannot disagree
  // with the profit line directly beneath it.
  it('reports what went back, the tax inside it, and what was kept', () => {
    const sale = makeSale({
      totalCents: 1292,
      taxCents: 32,
      items: [makeItem({ id: 'a', quantity: 1, unitPriceCents: 1260, lineTotalCents: 1260, unitCostCents: 500 })],
      refunds: [
        {
          id: 'r1',
          saleId: 's1',
          refundedBy: null,
          totalCents: 1292,
          createdAt: new Date(2026, 7, 3).toISOString(),
          items: [{ id: 'ri1', refundId: 'r1', saleItemId: 'a', productId: 'p1', quantity: 1, amountCents: 1292 }],
        },
      ],
    });
    const result = saleProfit(sale);
    expect(result.refundedCents).toBe(1292);
    expect(result.refundedTaxCents).toBe(32);
    expect(result.keptCents).toBe(0);
  });

  it('leaves the kept figure at the total when nothing was refunded', () => {
    const result = saleProfit(makeSale({ totalCents: 2310, taxCents: 110 }));
    expect(result.refundedCents).toBe(0);
    expect(result.refundedTaxCents).toBe(0);
    expect(result.keptCents).toBe(2310);
  });
});

// What the row badge says. A pure function rather than a branch inside the
// row, because "how much of this came back" is the question the old `1↩`
// glyph could not answer and the one worth pinning down in a test.
describe('saleRefundState', () => {
  const refundOf = (saleItemId: string, quantity: number, totalCents: number) => ({
    id: `r-${saleItemId}-${quantity}`,
    saleId: 's1',
    refundedBy: null,
    totalCents,
    createdAt: new Date(2026, 7, 3).toISOString(),
    items: [{ id: 'ri1', refundId: 'r1', saleItemId, productId: 'p1', quantity, amountCents: totalCents }],
  });

  it('reports nothing for a sale that was never refunded', () => {
    expect(saleRefundState(makeSale())).toEqual({ kind: 'none' });
  });

  it('reports a whole basket going back as full', () => {
    const sale = makeSale({
      items: [makeItem({ id: 'a', quantity: 2, lineTotalCents: 4400 })],
      refunds: [refundOf('a', 2, 4400)],
    });
    expect(saleRefundState(sale)).toEqual({ kind: 'full' });
  });

  // The distinction the old glyph lost: one unit back out of four and the
  // whole basket back both rendered as `1↩`.
  it('counts the units when only part of the basket went back', () => {
    const sale = makeSale({
      items: [makeItem({ id: 'a', quantity: 4, lineTotalCents: 8800 })],
      refunds: [refundOf('a', 1, 2200)],
    });
    expect(saleRefundState(sale)).toEqual({ kind: 'partial', refundedQuantity: 1, totalQuantity: 4 });
  });

  it('adds up refunds taken across several visits', () => {
    const sale = makeSale({
      items: [makeItem({ id: 'a', quantity: 4, lineTotalCents: 8800 })],
      refunds: [refundOf('a', 1, 2200), refundOf('a', 2, 4400)],
    });
    expect(saleRefundState(sale)).toEqual({ kind: 'partial', refundedQuantity: 3, totalQuantity: 4 });
  });

  it('reads a basket refunded line by line as full once nothing is left', () => {
    const sale = makeSale({
      items: [makeItem({ id: 'a', quantity: 1, lineTotalCents: 2200 }), makeItem({ id: 'b', quantity: 1, lineTotalCents: 3000 })],
      refunds: [refundOf('a', 1, 2200), refundOf('b', 1, 3000)],
    });
    expect(saleRefundState(sale)).toEqual({ kind: 'full' });
  });

  // A refund whose lines an edit later dropped. Money genuinely went back, so
  // the row must not go silent -- there is nothing left to count against, and
  // saying nothing came back is the one answer that is definitely wrong.
  it('still reports a refund whose original lines were edited away', () => {
    const sale = makeSale({
      items: [makeItem({ id: 'b', quantity: 1, lineTotalCents: 2200 })],
      refunds: [refundOf('gone', 1, 2200)],
    });
    expect(saleRefundState(sale)).toEqual({ kind: 'full' });
  });

  it('still reports a refund on a sale whose items are all gone', () => {
    const sale = makeSale({ items: [], refunds: [refundOf('gone', 1, 2200)] });
    expect(saleRefundState(sale)).toEqual({ kind: 'full' });
  });
});

describe('the row and the period agree to the cent', () => {
  // saleProfit used to round the SUMMED refund total once while
  // netRevenueCents rounded each refund and then added them, so a sale
  // refunded in two visits could report a penny more revenue on its own row
  // than it contributed to the period containing it.
  it('nets the same revenue whether a sale is read alone or in a period', () => {
    const refund = (id: string) => ({
      id,
      saleId: 's1',
      refundedBy: null,
      totalCents: 333,
      createdAt: new Date(2026, 7, 3).toISOString(),
      items: [{ id: `ri-${id}`, refundId: id, saleItemId: 'a', productId: 'p1', quantity: 1, amountCents: 333 }],
    });
    const sale = makeSale({
      totalCents: 1000,
      taxCents: 100,
      items: [makeItem({ id: 'a', quantity: 4, lineTotalCents: 900, unitCostCents: 0 })],
      refunds: [refund('r1'), refund('r2')],
    });
    const periodView = netRevenueCents(
      [sale],
      [
        makeRefund({ id: 'r1', totalCents: 333, saleTotalCents: 1000, saleTaxCents: 100 }),
        makeRefund({ id: 'r2', totalCents: 333, saleTotalCents: 1000, saleTaxCents: 100 }),
      ]
    );
    expect(saleProfit(sale).netRevenueCents).toBe(periodView);
    expect(periodView).toBe(300);
  });
});

// What a customer actually spent, for their lifetime total and their ranking.
//
// Both sides are the PAID figure -- `sales.total_cents` and
// `refunds.total_cents` are each tax-inclusive since migration
// 20260820000200 -- so unlike the product and revenue figures these subtract
// directly, with no basis to reconcile.
describe('keptSpendCents', () => {
  it('counts an unrefunded order in full', () => {
    expect(keptSpendCents([{ totalCents: 2310, refundedCents: 0 }])).toBe(2310);
  });

  it('takes a refund off the order it belongs to', () => {
    expect(keptSpendCents([{ totalCents: 2310, refundedCents: 1155 }])).toBe(1155);
  });

  it('drops a fully refunded order to nothing rather than counting it as spend', () => {
    expect(keptSpendCents([{ totalCents: 2310, refundedCents: 2310 }])).toBe(0);
  });

  it('adds up across orders', () => {
    expect(
      keptSpendCents([
        { totalCents: 5000, refundedCents: 0 },
        { totalCents: 2310, refundedCents: 2310 },
        { totalCents: 1000, refundedCents: 400 },
      ])
    ).toBe(5600);
  });

  // A sale over-refunded under the pre-migration maths would otherwise make a
  // customer's lifetime spend go DOWN past zero and rank them below someone
  // who never bought anything.
  it('never lets an over-refunded order push lifetime spend negative', () => {
    expect(keptSpendCents([{ totalCents: 1000, refundedCents: 1200 }])).toBe(0);
    expect(keptSpendCents([{ totalCents: 5000, refundedCents: 0 }, { totalCents: 1000, refundedCents: 1200 }])).toBe(5000);
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

  // Same double-subtraction the period total had: refundCents is what the
  // customer was handed (tax included), so the chart has to net the tax out of
  // it before it meets a revenue line that already excludes tax.
  it('nets only the pre-tax share of a refund against a taxed sale', () => {
    const sales = [makeSale({ createdAt: new Date(2026, 7, 1, 9, 0).toISOString(), totalCents: 2310, taxCents: 110 })];
    const refunds = [
      makeRefund({
        createdAt: new Date(2026, 7, 3, 9, 0).toISOString(),
        totalCents: 2310,
        saleTotalCents: 2310,
        saleTaxCents: 110,
      }),
    ];
    const buckets = bucketDailyTotals(sales, refunds, since, until);
    expect(buckets[0].netRevenueCents).toBe(2200);
    expect(buckets[2].netRevenueCents).toBe(-2200);
  });

  // The Overview CSV prints these columns per day, and an accountant reads
  // across the row. Gross − Refunds − Sales tax owed has to land on Revenue,
  // or the export is four numbers that quietly disagree.
  it('gives a day whose columns reconcile across the row', () => {
    const sales = [makeSale({ createdAt: new Date(2026, 7, 1, 9, 0).toISOString(), totalCents: 2310, taxCents: 110 })];
    const refunds = [
      makeRefund({
        createdAt: new Date(2026, 7, 1, 10, 0).toISOString(),
        totalCents: 1155,
        saleTotalCents: 2310,
        saleTaxCents: 110,
      }),
    ];
    const [day] = bucketDailyTotals(sales, refunds, since, until);
    expect(day.grossCents - day.refundCents - (day.taxCents - day.refundTaxCents)).toBe(day.netRevenueCents);
  });

  // A refund landing on a day with no sales of its own drives the owed-tax
  // column negative, which is the correct reading: that tax was remitted-in-
  // waiting last period and has now gone back out.
  it('reconciles a day that holds only a refund', () => {
    const sales = [makeSale({ createdAt: new Date(2026, 7, 1, 9, 0).toISOString(), totalCents: 2310, taxCents: 110 })];
    const refunds = [
      makeRefund({
        createdAt: new Date(2026, 7, 3, 9, 0).toISOString(),
        totalCents: 2310,
        saleTotalCents: 2310,
        saleTaxCents: 110,
      }),
    ];
    const day = bucketDailyTotals(sales, refunds, since, until)[2];
    expect(day.refundTaxCents).toBe(110);
    expect(day.grossCents - day.refundCents - (day.taxCents - day.refundTaxCents)).toBe(day.netRevenueCents);
    expect(day.netRevenueCents).toBe(-2200);
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

  // Goods that came back were not sold, so a heavily returned product must not
  // rank as a top seller. Netted from the sale's own lines and kept in
  // `lineTotalCents` throughout: `refund_items.amount_cents` is a share of
  // `sales.total_cents` and carries tax, so subtracting it from a line total
  // would mix two bases -- the same error that put -$0.32 on a sale detail.
  const refundOfLine = (saleItemId: string, productId: string, quantity: number) => ({
    id: `r-${saleItemId}`,
    saleId: 's1',
    refundedBy: null,
    totalCents: 0,
    createdAt: new Date(2026, 7, 3).toISOString(),
    items: [{ id: 'ri1', refundId: `r-${saleItemId}`, saleItemId, productId, quantity, amountCents: 0 }],
  });

  it('nets returned units out of the ranking', () => {
    const sale = makeSale({ items: [rice(), oil()], refunds: [refundOfLine('i-rice', 'p-rice', 1)] });
    const rows = productPerformance([sale]);
    const riceRow = rows.find((r) => r.productId === 'p-rice');
    expect(riceRow?.unitsSold).toBe(1);
    expect(riceRow?.revenueCents).toBe(1150);
  });

  it('drops a product returned in full rather than ranking it at zero', () => {
    const sale = makeSale({ items: [rice(), oil()], refunds: [refundOfLine('i-rice', 'p-rice', 2)] });
    const rows = productPerformance([sale]);
    expect(rows.map((r) => r.productId)).toEqual(['p-oil']);
  });

  it('leaves an unrefunded line at its full take', () => {
    const sale = makeSale({ items: [rice()], refunds: [] });
    expect(productPerformance([sale])[0].revenueCents).toBe(2300);
  });

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

describe('productDailyRevenue', () => {
  const on = (day: number, lineTotalCents: number) =>
    makeSale({
      id: `s${day}-${lineTotalCents}`,
      createdAt: new Date(2026, 7, day, 11, 0).toISOString(),
      items: [makeItem({ productId: 'p-rice', productName: 'Rice', lineTotalCents, quantity: 1 })],
    });

  // The sparkline sits under the mover card's figure, so it has to net the
  // same way productPerformance does or the line contradicts the number over it.
  it('nets a returned line out of its day', () => {
    const sale = makeSale({
      createdAt: new Date(2026, 7, 1, 11, 0).toISOString(),
      items: [makeItem({ id: 'i1', productId: 'p-rice', productName: 'Rice', lineTotalCents: 2000, quantity: 2 })],
      refunds: [
        {
          id: 'r1',
          saleId: 's1',
          refundedBy: null,
          totalCents: 0,
          createdAt: new Date(2026, 7, 1).toISOString(),
          items: [{ id: 'ri1', refundId: 'r1', saleItemId: 'i1', productId: 'p-rice', quantity: 1, amountCents: 0 }],
        },
      ],
    });
    const series = productDailyRevenue([sale], { productId: 'p-rice', name: 'Rice' }, new Date(2026, 7, 1), new Date(2026, 7, 2));
    expect(series[0]).toBe(1000);
  });

  it('gives one figure per day in the range, zeros included', () => {
    const series = productDailyRevenue(
      [on(1, 500), on(3, 200), on(3, 100)],
      { productId: 'p-rice', name: 'Rice' },
      new Date(2026, 7, 1),
      new Date(2026, 7, 4)
    );
    expect(series).toEqual([500, 0, 300, 0]);
  });

  it('counts only the product asked for', () => {
    const mixed = makeSale({
      id: 'mixed',
      createdAt: new Date(2026, 7, 1, 11, 0).toISOString(),
      items: [
        makeItem({ id: 'a', productId: 'p-rice', productName: 'Rice', lineTotalCents: 500, quantity: 1 }),
        makeItem({ id: 'b', productId: 'p-oil', productName: 'Oil', lineTotalCents: 900, quantity: 1 }),
      ],
    });
    expect(productDailyRevenue([mixed], { productId: 'p-rice', name: 'Rice' }, new Date(2026, 7, 1), new Date(2026, 7, 1))).toEqual([500]);
  });

  it('matches a deleted product by name, the same key productPerformance uses', () => {
    const sale = makeSale({
      id: 'gone',
      createdAt: new Date(2026, 7, 1, 11, 0).toISOString(),
      items: [makeItem({ productId: null, productName: 'Retired blend', lineTotalCents: 700, quantity: 1 })],
    });
    expect(productDailyRevenue([sale], { productId: null, name: 'Retired blend' }, new Date(2026, 7, 1), new Date(2026, 7, 1))).toEqual([700]);
  });
});
