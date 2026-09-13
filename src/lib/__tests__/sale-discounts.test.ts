import { discountPercentLabel, lineDiscount, saleDiscountSummary } from '@/lib/sale-discounts';

type Line = Parameters<typeof lineDiscount>[0];

function line(overrides: Partial<Line>): Line {
  const unitPriceCents = overrides.unitPriceCents ?? 1000;
  const quantity = overrides.quantity ?? 1;
  const discountCents = overrides.discountCents ?? 0;
  return {
    unitPriceCents,
    quantity,
    discountCents,
    lineTotalCents: unitPriceCents * quantity - discountCents,
    promotionName: null,
    ...overrides,
  };
}

describe('discountPercentLabel', () => {
  it('shows a whole number when the share is whole, to the nearest tenth', () => {
    expect(discountPercentLabel(100, 999)).toBe('10%');
    expect(discountPercentLabel(56, 1400)).toBe('4%');
  });

  it('keeps one decimal when it is not', () => {
    expect(discountPercentLabel(42, 1000)).toBe('4.2%');
  });

  it('says nothing about a discount on nothing', () => {
    expect(discountPercentLabel(0, 1000)).toBeNull();
    expect(discountPercentLabel(100, 0)).toBeNull();
  });
});

describe('lineDiscount', () => {
  it('gives list, off, paid and the promotion behind it', () => {
    expect(lineDiscount(line({ unitPriceCents: 999, quantity: 2, discountCents: 200, promotionName: 'Party and BS' }), 'yusef')).toEqual({
      listCents: 1998,
      offCents: 200,
      paidCents: 1798,
      percent: '10%',
      reason: 'Party and BS',
    });
  });

  it('names a typed-in discount after the cashier, or plainly when there is none', () => {
    expect(lineDiscount(line({ unitPriceCents: 1400, discountCents: 56 }), 'Fasia').reason).toBe('Manual discount by Fasia');
    expect(lineDiscount(line({ unitPriceCents: 1400, discountCents: 56 }), null).reason).toBe('Manual discount');
  });

  it('has no reason and no percent when nothing came off', () => {
    const result = lineDiscount(line({}), 'yusef');
    expect(result.reason).toBeNull();
    expect(result.percent).toBeNull();
  });
});

describe('saleDiscountSummary', () => {
  it('adds up a promotion sale from list price to total (sale 199b42ed)', () => {
    const summary = saleDiscountSummary({
      items: [
        line({ unitPriceCents: 999, quantity: 2, discountCents: 200, promotionName: 'Party and BS' }),
        line({ unitPriceCents: 750, quantity: 2, discountCents: 150, promotionName: 'Party and BS' }),
        line({ unitPriceCents: 400, quantity: 1, discountCents: 40, promotionName: 'Party and BS' }),
      ],
      discountCents: 0,
      pointsRedeemedCents: 0,
      taxCents: 88,
      totalCents: 3596,
    });
    expect(summary).toMatchObject({
      listCents: 3898,
      itemDiscountCents: 390,
      discountedItemCount: 3,
      saleDiscountCents: 0,
      subtotalCents: 3508,
      totalOffCents: 390,
      totalOffPercent: '10%',
      promotionNames: ['Party and BS'],
      onlyPromotion: 'Party and BS',
    });
    expect(summary.subtotalCents + 88).toBe(3596);
  });

  it('takes a whole-sale discount as a share of what the items came to (sale 1beb97f2)', () => {
    const summary = saleDiscountSummary({
      items: [line({ unitPriceCents: 600, quantity: 2 }), line({ unitPriceCents: 200, quantity: 2 }), line({ unitPriceCents: 400 }), line({ unitPriceCents: 300 })],
      discountCents: 230,
      pointsRedeemedCents: 0,
      taxCents: 52,
      totalCents: 2122,
    });
    expect(summary.saleDiscountPercent).toBe('10%');
    expect(summary.subtotalCents).toBe(2070);
    expect(summary.totalOffCents).toBe(230);
  });

  it('takes the sale discount % off what was left after item discounts', () => {
    const summary = saleDiscountSummary({
      items: [line({ unitPriceCents: 1000, discountCents: 500 })],
      discountCents: 50,
      pointsRedeemedCents: 0,
      taxCents: 0,
      totalCents: 450,
    });
    expect(summary.saleDiscountPercent).toBe('10%');
    expect(summary.totalOffPercent).toBe('55%');
    expect(summary.onlyPromotion).toBeNull();
  });

  it('knows tax added on top from tax already inside the price', () => {
    const base = { items: [line({ unitPriceCents: 600, quantity: 2 })], discountCents: 0, pointsRedeemedCents: 0, taxCents: 29 };
    // Sale 68d2dea8: $12.00 total with $0.29 of tax inside it.
    expect(saleDiscountSummary({ ...base, totalCents: 1200 }).taxIncluded).toBe(true);
    expect(saleDiscountSummary({ ...base, totalCents: 1229 }).taxIncluded).toBe(false);
    expect(saleDiscountSummary({ ...base, taxCents: 0, totalCents: 1200 }).taxIncluded).toBe(false);
  });

  it('shows points in the summary but keeps them out of what was taken off', () => {
    const summary = saleDiscountSummary({
      items: [line({ unitPriceCents: 1000 })],
      discountCents: 0,
      pointsRedeemedCents: 200,
      taxCents: 0,
      totalCents: 800,
    });
    expect(summary.subtotalCents).toBe(800);
    expect(summary.totalOffCents).toBe(0);
    expect(summary.totalOffPercent).toBeNull();
  });
});
