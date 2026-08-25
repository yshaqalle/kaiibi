import { act, create, type ReactTestRendererJSON } from 'react-test-renderer';

import { ProductTile } from '@/components/storefront/product-tile';
import { paletteColors } from '@/lib/storefront-catalog';
import type { StorefrontProduct } from '@/types/models';

// `@testing-library/react-native` is not installed in this repo (see
// stat-tile.test.tsx and sale-line.test.tsx for the same pattern) -- flatten
// the rendered tree to strings instead of reaching for a query library the
// repo does not have.
function textsIn(node: ReactTestRendererJSON | ReactTestRendererJSON[] | string | null): string[] {
  if (node == null) return [];
  if (typeof node === 'string') return [node];
  if (Array.isArray(node)) return node.flatMap(textsIn);
  return textsIn(node.children as ReactTestRendererJSON[] | null);
}

function countOf(texts: string[], target: string): number {
  return texts.filter((t) => t === target).length;
}

const colors = paletteColors('ink');

const base: StorefrontProduct = {
  id: 'p1',
  name: 'Anker 20W charger',
  description: null,
  category: 'Phone',
  priceCents: 1200,
  stock: 5,
  imageUrl: null,
};

function renderTile(product: StorefrontProduct) {
  let tree!: ReturnType<typeof create>;
  act(() => {
    tree = create(<ProductTile product={product} colors={colors} />);
  });
  return textsIn(tree.toJSON() as ReactTestRendererJSON);
}

describe('ProductTile', () => {
  it('shows the name and price', () => {
    const texts = renderTile(base);
    expect(texts).toContain('Anker 20W charger');
    expect(texts).toContain('$12.00');
  });

  it('names the product in the fallback tile exactly once when there is no photo', () => {
    const texts = renderTile(base);
    // The fallback IS the label -- the body must not repeat the name, or the
    // tile reads as a rendering bug rather than a deliberate price-label look.
    expect(countOf(texts, 'Anker 20W charger')).toBe(1);
    expect(texts).toContain('$12.00');
    expect(texts).toContain('In stock');
  });

  it('names the product in the body exactly once when there is a photo', () => {
    const texts = renderTile({ ...base, imageUrl: 'https://example.test/a.jpg' });
    expect(countOf(texts, 'Anker 20W charger')).toBe(1);
    expect(texts).toContain('$12.00');
    expect(texts).toContain('In stock');
  });

  it('marks an out-of-stock product without hiding it', () => {
    const texts = renderTile({ ...base, stock: 0 });
    expect(texts).toContain('Out of stock — ask us');
  });

  it('says in stock when there is stock', () => {
    const texts = renderTile(base);
    expect(texts).toContain('In stock');
  });
});
