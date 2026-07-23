import { deriveCategories, deriveTags } from '@/lib/product-taxonomy';
import type { Product } from '@/types/models';

function makeProduct(overrides: Partial<Product> = {}): Product {
  return {
    id: 'p1', shopId: 's1', name: 'Toner', description: null, sku: null, barcode: null, brand: null,
    category: null, tags: [], supplierName: null, costCents: null, priceCents: 2400, stock: 10,
    reorderLevel: null, shelfNumber: null, expiryDate: null, batchNumber: null, imageUrl: null,
    isListedOnline: false, createdAt: '', updatedAt: '', ...overrides,
  };
}

describe('deriveCategories', () => {
  it('returns distinct, alphabetically sorted categories', () => {
    const products = [
      makeProduct({ id: 'p1', category: 'Toners' }),
      makeProduct({ id: 'p2', category: 'Serums' }),
      makeProduct({ id: 'p3', category: 'Toners' }),
    ];
    expect(deriveCategories(products)).toEqual(['Serums', 'Toners']);
  });

  it('excludes null and empty-string categories', () => {
    const products = [
      makeProduct({ id: 'p1', category: null }),
      makeProduct({ id: 'p2', category: '' }),
      makeProduct({ id: 'p3', category: 'Masks' }),
    ];
    expect(deriveCategories(products)).toEqual(['Masks']);
  });

  it('returns an empty array for no products', () => {
    expect(deriveCategories([])).toEqual([]);
  });
});

describe('deriveTags', () => {
  it('returns distinct, alphabetically sorted tags flattened across products', () => {
    const products = [
      makeProduct({ id: 'p1', tags: ['bestseller', 'toner'] }),
      makeProduct({ id: 'p2', tags: ['toner', 'sensitive-skin'] }),
    ];
    expect(deriveTags(products)).toEqual(['bestseller', 'sensitive-skin', 'toner']);
  });

  it('excludes empty-string tags', () => {
    const products = [makeProduct({ id: 'p1', tags: ['', 'new'] })];
    expect(deriveTags(products)).toEqual(['new']);
  });

  it('returns an empty array for no products', () => {
    expect(deriveTags([])).toEqual([]);
  });
});
