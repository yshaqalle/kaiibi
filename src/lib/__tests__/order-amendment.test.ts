import { amendmentLines, summariseAmendment, type AmendLineDraft } from '@/lib/order-amendment';

// 5 bags agreed at 2500, today's shelf 3000. The two prices are deliberately
// far apart so no assertion below can pass by arithmetic coincidence.
const RICE: AmendLineDraft = {
  productId: 'prod-rice',
  productName: 'Basmati rice',
  agreedUnitPriceCents: 2500,
  currentUnitPriceCents: 3000,
  originalQuantity: 5,
  quantity: 5,
};

const OIL: AmendLineDraft = {
  productId: 'prod-oil',
  productName: 'Cooking oil',
  agreedUnitPriceCents: 1000,
  currentUnitPriceCents: 1000,
  originalQuantity: 2,
  quantity: 2,
};

const base = (lines: AmendLineDraft[], over: Partial<Parameters<typeof summariseAmendment>[0]> = {}) =>
  summariseAmendment({
    lines,
    pricing: 'agreed',
    deliveryFeeCents: 0,
    previousTotalCents: lines.reduce((n, l) => n + l.agreedUnitPriceCents * l.originalQuantity, 0),
    ...over,
  });

describe('summariseAmendment', () => {
  it('reports no changes when nothing has moved', () => {
    const s = base([RICE, OIL]);
    expect(s.hasChanges).toBe(false);
    expect(s.changes).toEqual([]);
    expect(s.differenceCents).toBe(0);
    expect(s.nextTotalCents).toBe(s.previousTotalCents);
  });

  it('prices a reduction at the agreed price, not today’s', () => {
    const s = base([{ ...RICE, quantity: 3 }]);
    // 3 x 2500, NOT 3 x 3000. 500 apart per unit, so the modes cannot agree.
    expect(s.nextSubtotalCents).toBe(7500);
    expect(s.nextTotalCents).toBe(7500);
    expect(s.previousTotalCents).toBe(12500);
    expect(s.differenceCents).toBe(-5000);
  });

  it('prices at today’s shelf when the shop chooses to re-price', () => {
    const s = base([{ ...RICE, quantity: 3 }], { pricing: 'current' });
    expect(s.nextSubtotalCents).toBe(9000);
    expect(s.differenceCents).toBe(-3500);
  });

  // The one an amend can get wrong quietly: nothing about the ORDER changed,
  // but the customer now owes more because the shop re-priced.
  it('shows a rise when re-pricing an otherwise untouched order', () => {
    const s = base([RICE], { pricing: 'current' });
    expect(s.nextSubtotalCents).toBe(15000);
    expect(s.differenceCents).toBe(2500);
    expect(s.hasChanges).toBe(true);
  });

  it('names every re-priced line, with both figures', () => {
    const s = base([RICE, OIL], { pricing: 'current' });
    // Oil costs the same today as it was agreed at, so it is NOT a re-price
    // and must not be listed -- otherwise the panel lists every line on the
    // order and says nothing.
    expect(s.changes).toEqual([
      { kind: 'repriced', productName: 'Basmati rice', fromCents: 2500, toCents: 3000 },
    ]);
  });

  it('names a quantity change with both quantities', () => {
    const s = base([{ ...RICE, quantity: 3 }, OIL]);
    expect(s.changes).toEqual([{ kind: 'quantity', productName: 'Basmati rice', from: 5, to: 3 }]);
  });

  it('reports a line dropped to zero as removed, not as a quantity of zero', () => {
    const s = base([{ ...RICE, quantity: 0 }, OIL]);
    expect(s.changes).toEqual([{ kind: 'removed', productName: 'Basmati rice', reason: 'dropped' }]);
    expect(s.nextSubtotalCents).toBe(2000);
  });

  // A line whose product was deleted carries productId null and CANNOT be
  // kept -- amend_order refuses it (order_product_deleted). The panel has to
  // say so before saving, because the shop did not ask for it to go.
  it('always reports a deleted-product line as removed, whatever its quantity', () => {
    const gone: AmendLineDraft = {
      productId: null,
      productName: 'Discontinued',
      agreedUnitPriceCents: 500,
      currentUnitPriceCents: null,
      originalQuantity: 1,
      quantity: 1,
    };
    const s = base([RICE, gone]);
    expect(s.changes).toEqual([
      { kind: 'removed', productName: 'Discontinued', reason: 'product_deleted' },
    ]);
    // It contributes nothing to the new total even though its quantity is 1.
    expect(s.nextSubtotalCents).toBe(12500);
    expect(s.hasChanges).toBe(true);
  });

  it('carries the delivery fee into the new total without re-pricing it', () => {
    const s = base([{ ...RICE, quantity: 2 }], { deliveryFeeCents: 1500, previousTotalCents: 14000 });
    expect(s.nextSubtotalCents).toBe(5000);
    expect(s.deliveryFeeCents).toBe(1500);
    expect(s.nextTotalCents).toBe(6500);
    expect(s.differenceCents).toBe(-7500);
  });

  it('blocks an amend that would leave nothing on the order', () => {
    const s = base([{ ...RICE, quantity: 0 }, { ...OIL, quantity: 0 }]);
    expect(s.blocker).toBe('no_items');
    expect(s.nextSubtotalCents).toBe(0);
  });

  it('does not block while at least one line survives', () => {
    expect(base([{ ...RICE, quantity: 0 }, OIL]).blocker).toBeNull();
  });

  // Falling back to the agreed price would silently charge one price on a
  // line the shop believes it re-priced. Blocking is the honest answer.
  it('blocks re-pricing when a surviving line has no current price to read', () => {
    const noPrice: AmendLineDraft = { ...OIL, currentUnitPriceCents: null };
    expect(base([noPrice], { pricing: 'current' }).blocker).toBe('price_unknown');
    // ...but the same line is fine at the agreed price.
    expect(base([noPrice]).blocker).toBeNull();
  });
});

describe('amendmentLines', () => {
  it('sends every line that has a product, including the zeros that remove one', () => {
    expect(amendmentLines([{ ...RICE, quantity: 0 }, OIL])).toEqual([
      { productId: 'prod-rice', quantity: 0 },
      { productId: 'prod-oil', quantity: 2 },
    ]);
  });

  // Naming it raises order_product_deleted; omitting it removes it, which is
  // the only thing that can be done with such a line.
  it('omits a deleted-product line entirely rather than naming it', () => {
    const gone: AmendLineDraft = {
      productId: null,
      productName: 'Discontinued',
      agreedUnitPriceCents: 500,
      currentUnitPriceCents: null,
      originalQuantity: 1,
      quantity: 1,
    };
    expect(amendmentLines([RICE, gone])).toEqual([{ productId: 'prod-rice', quantity: 5 }]);
  });
});
