import { editedLineDiscountCents, editedSaleTotals } from '@/lib/sale-edit';

describe('editedLineDiscountCents', () => {
  it('keeps the discount when the quantity holds or rises', () => {
    expect(editedLineDiscountCents({ discountCents: 500, originalQuantity: 2, quantity: 2, unitPriceCents: 1600 })).toBe(500);
    expect(editedLineDiscountCents({ discountCents: 500, originalQuantity: 2, quantity: 3, unitPriceCents: 1600 })).toBe(500);
  });

  it('shrinks the discount with the quantity, so a promotion cap is never exceeded', () => {
    expect(editedLineDiscountCents({ discountCents: 960, originalQuantity: 3, quantity: 1, unitPriceCents: 1600 })).toBe(320);
  });

  it('never discounts a line below zero', () => {
    expect(editedLineDiscountCents({ discountCents: 5000, originalQuantity: 1, quantity: 1, unitPriceCents: 1600 })).toBe(1600);
  });

  it('gives a line added during the edit no discount', () => {
    expect(editedLineDiscountCents({ discountCents: 0, originalQuantity: 0, quantity: 1, unitPriceCents: 1600 })).toBe(0);
  });
});

describe('editedSaleTotals', () => {
  it('nets line discounts, the sale discount and redeemed points before tax -- as edit_sale does', () => {
    // $50.00 gross, $4.00 off the lines, $20.50 off the sale, $0 points, no tax.
    const totals = editedSaleTotals({
      lines: [
        { unitPriceCents: 1800, quantity: 1, discountCents: 0 },
        { unitPriceCents: 1600, quantity: 2, discountCents: 400 },
      ],
      saleDiscountCents: 2050,
      pointsRedeemedCents: 0,
      taxRatePercent: null,
    });
    expect(totals.totalCents).toBe(2550);
  });

  it('taxes the discounted amount, not the gross', () => {
    const totals = editedSaleTotals({
      lines: [{ unitPriceCents: 10000, quantity: 1, discountCents: 1000 }],
      saleDiscountCents: 0,
      pointsRedeemedCents: 1000,
      taxRatePercent: 5,
    });
    expect(totals.taxCents).toBe(400);
    expect(totals.totalCents).toBe(8400);
  });

  it('caps the sale discount at what the lines add up to', () => {
    const totals = editedSaleTotals({
      lines: [{ unitPriceCents: 1000, quantity: 1, discountCents: 0 }],
      saleDiscountCents: 5000,
      pointsRedeemedCents: 0,
      taxRatePercent: null,
    });
    expect(totals.saleDiscountCents).toBe(1000);
    expect(totals.totalCents).toBe(0);
  });
});
