import { buildSalePayload, cartTotalCents } from '@/lib/cart';
import type { CartLine, Product } from '@/types/models';

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
  it('maps cart lines to product_id/quantity pairs', () => {
    const lines: CartLine[] = [{ product: makeProduct({ id: 'p1' }), quantity: 3 }];
    expect(buildSalePayload(lines)).toEqual([{ product_id: 'p1', quantity: 3 }]);
  });
});
