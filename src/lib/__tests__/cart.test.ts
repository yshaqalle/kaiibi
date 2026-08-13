import { buildSalePayload, cartTotalCents } from '@/lib/cart';
import type { CartLine, Product, Promotion } from '@/types/models';

function makeProduct(overrides: Partial<Product> = {}): Product {
  return {
    id: 'p1', shopId: 's1', name: 'Toner', description: null, sku: null, barcode: null, brand: null,
    category: null, tags: [], supplierName: null, costCents: null, priceCents: 2400, stock: 10,
    reorderLevel: null, shelfNumber: null, expiryDate: null, batchNumber: null, imageUrl: null,
    isListedOnline: false, createdAt: '', updatedAt: '', ...overrides,
  };
}

describe('cartTotalCents', () => {
  it('sums price times quantity across lines', () => {
    const lines: CartLine[] = [
      { product: makeProduct({ id: 'p1', priceCents: 2400 }), quantity: 2 },
      { product: makeProduct({ id: 'p2', priceCents: 1000 }), quantity: 1 },
    ];
    expect(cartTotalCents(lines)).toBe(2400 * 2 + 1000);
  });

  it('returns 0 for an empty cart', () => {
    expect(cartTotalCents([])).toBe(0);
  });
});

describe('buildSalePayload', () => {
  it('maps cart lines to product_id/quantity/discount_cents triples', () => {
    const lines: CartLine[] = [{ product: makeProduct({ id: 'p1' }), quantity: 3 }];
    expect(buildSalePayload(lines)).toEqual([
      { product_id: 'p1', quantity: 3, discount_cents: 0, promotion_id: null, promotion_name: null },
    ]);
  });

  it('includes a manual per-line discount when set', () => {
    const lines: CartLine[] = [{ product: makeProduct({ id: 'p1', priceCents: 1000 }), quantity: 2, manualDiscount: { type: 'fixed', value: 300 } }];
    expect(buildSalePayload(lines)).toEqual([
      { product_id: 'p1', quantity: 2, discount_cents: 300, promotion_id: null, promotion_name: null },
    ]);
  });
});

function makePromotion(overrides: Partial<Promotion> = {}): Promotion {
  return {
    id: 'promo1', shopId: 's1', locationId: null, name: 'Eid weekend',
    discountType: 'percentage', discountValue: 20, scope: 'store', scopeValue: null,
    active: true, startsAt: null, endsAt: null, autoApply: true, archivedAt: null,
    createdAt: '', ...overrides,
  };
}

describe('buildSalePayload attribution', () => {
  it('names the promotion that produced the discount', () => {
    const lines: CartLine[] = [{ product: makeProduct({ id: 'p1', priceCents: 1800 }), quantity: 1 }];
    expect(buildSalePayload(lines, [makePromotion()])).toEqual([
      { product_id: 'p1', quantity: 1, discount_cents: 360, promotion_id: 'promo1', promotion_name: 'Eid weekend' },
    ]);
  });

  it('sends nulls when no promotion applied', () => {
    const lines: CartLine[] = [{ product: makeProduct({ id: 'p1' }), quantity: 1 }];
    expect(buildSalePayload(lines)).toEqual([
      { product_id: 'p1', quantity: 1, discount_cents: 0, promotion_id: null, promotion_name: null },
    ]);
  });

  it('sends nulls for a manual discount, which has no promotion behind it', () => {
    const lines: CartLine[] = [{
      product: makeProduct({ id: 'p1', priceCents: 1000 }), quantity: 2,
      manualDiscount: { type: 'fixed', value: 300 },
    }];
    expect(buildSalePayload(lines, [makePromotion()])).toEqual([
      { product_id: 'p1', quantity: 2, discount_cents: 300, promotion_id: null, promotion_name: null },
    ]);
  });

  it('sends nulls when the only promotion has expired', () => {
    const lines: CartLine[] = [{ product: makeProduct({ id: 'p1', priceCents: 1800 }), quantity: 1 }];
    const expired = makePromotion({ endsAt: '2020-01-01T00:00:00Z' });
    expect(buildSalePayload(lines, [expired])).toEqual([
      { product_id: 'p1', quantity: 1, discount_cents: 0, promotion_id: null, promotion_name: null },
    ]);
  });
});
