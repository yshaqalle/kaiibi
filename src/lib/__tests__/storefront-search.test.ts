import { SEARCH_THRESHOLD, searchProducts, shouldOfferSearch } from '@/lib/storefront-search';
import type { StorefrontProduct } from '@/types/models';

function product(over: Partial<StorefrontProduct> & { id: string; name: string }): StorefrontProduct {
  return {
    description: null, category: null, priceCents: 1000, stock: 4, imageUrl: null, ...over,
  };
}

const catalogue: StorefrontProduct[] = [
  product({ id: '1', name: 'Paracetamol 500mg', category: 'Analgesics' }),
  product({ id: '2', name: 'Ibuprofen 200mg', category: 'Analgesics' }),
  product({ id: '3', name: 'Amoxicillin 250mg', category: 'Antibiotics' }),
  product({ id: '4', name: 'Cough syrup', category: 'Cold & flu', description: 'Honey and lemon' }),
];

describe('searching a catalogue', () => {
  it('returns everything for an empty or whitespace query', () => {
    expect(searchProducts(catalogue, '')).toHaveLength(4);
    expect(searchProducts(catalogue, '   ')).toHaveLength(4);
  });

  it('matches a product name, case-insensitively', () => {
    expect(searchProducts(catalogue, 'PARACET').map((p) => p.id)).toEqual(['1']);
  });

  // The same case- and whitespace-insensitive rule filterByCategory already
  // applies, and for the same reason: the two sides have different authors and
  // were typed months apart.
  it('matches a category, so "analgesics" finds both of them', () => {
    expect(searchProducts(catalogue, '  analgesics ').map((p) => p.id)).toEqual(['1', '2']);
  });

  it('matches the description, which is where a shop puts the words a customer uses', () => {
    expect(searchProducts(catalogue, 'honey').map((p) => p.id)).toEqual(['4']);
  });

  it('returns nothing rather than everything when nothing matches', () => {
    expect(searchProducts(catalogue, 'bandage')).toHaveLength(0);
  });

  // A product with no category or description must not throw, and must still
  // be findable by name -- most products have neither field filled in.
  it('handles products with null category and description', () => {
    const sparse = [product({ id: '9', name: 'Plain thing' })];
    expect(searchProducts(sparse, 'plain').map((p) => p.id)).toEqual(['9']);
    expect(searchProducts(sparse, 'nothing')).toHaveLength(0);
  });
});

// A search box over six products is a control that costs a tap and saves
// nothing -- the whole catalogue is already on screen. It earns its place only
// once scrolling is the alternative.
describe('when a search box is worth its space', () => {
  function many(n: number) {
    return Array.from({ length: n }, (_, i) => product({ id: String(i), name: `Item ${i}` }));
  }

  it('is not offered for a short catalogue', () => {
    expect(shouldOfferSearch(many(SEARCH_THRESHOLD - 1))).toBe(false);
  });

  it('is offered at the threshold and above', () => {
    expect(shouldOfferSearch(many(SEARCH_THRESHOLD))).toBe(true);
    expect(shouldOfferSearch(many(SEARCH_THRESHOLD + 50))).toBe(true);
  });

  it('is not offered for an empty shop, which has its own empty state', () => {
    expect(shouldOfferSearch([])).toBe(false);
  });
});
