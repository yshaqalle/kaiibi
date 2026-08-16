import { act, create, type ReactTestRendererJSON } from 'react-test-renderer';

import { SaleLine } from '@/components/pos/sale-line';
import type { CartLine, Product } from '@/types/models';

function textsIn(node: ReactTestRendererJSON | ReactTestRendererJSON[] | string | null): string[] {
  if (node == null) return [];
  if (typeof node === 'string') return [node];
  if (Array.isArray(node)) return node.flatMap(textsIn);
  return textsIn(node.children as ReactTestRendererJSON[] | null);
}

const product = {
  id: 'p1',
  shopId: 'shop-1',
  name: 'Balanceful Cica Serum',
  brand: 'Torriden',
  category: 'Serums',
  priceCents: 2200,
  stock: 3,
  sku: null,
  barcode: null,
  imageUrl: null,
  reorderLevel: 5,
} as unknown as Product;

const line: CartLine = { product, quantity: 1 };

const props: React.ComponentProps<typeof SaleLine> = {
  line,
  grossCents: 2200,
  netCents: 1870,
  offerName: null,
  currency: null,
  canDiscount: true,
  editing: false,
  onToggleEditing: () => {},
  onQuantity: () => {},
  onRemove: () => {},
  onDiscount: () => {},
};

const render = (over: Partial<React.ComponentProps<typeof SaleLine>> = {}) => {
  let tree!: ReturnType<typeof create>;
  act(() => {
    tree = create(<SaleLine {...props} {...over} />);
  });
  return textsIn(tree.toJSON() as ReactTestRendererJSON);
};

describe('SaleLine', () => {
  it('names the product and what it comes to', () => {
    const texts = render();
    expect(texts).toContain('Balanceful Cica Serum');
    expect(texts).toContain('$18.70');
  });

  // Counted rather than searched: at full price the gross IS the net, so
  // "$22.00" is on the line either way. What changes is how many times -- once
  // struck through and once as the price, against twice when nothing came off
  // (the price and the line total).
  const occurrences = (texts: string[], needle: string) => texts.filter((text) => text === needle).length;

  it('strikes the old price only when something came off', () => {
    const discounted = render();
    expect(occurrences(discounted, '$22.00')).toBe(1);
    expect(occurrences(discounted, '$18.70')).toBe(2);

    const fullPrice = render({ netCents: 2200 });
    expect(occurrences(fullPrice, '$22.00')).toBe(2);
  });

  it('names the offer that did it', () => {
    expect(render({ offerName: 'Eid weekend' })).toContain('Eid weekend');
  });

  it('offers a discount only to someone allowed to give one', () => {
    expect(render()).toContain('Discount');
    expect(render({ canDiscount: false })).not.toContain('Discount');
  });

  it('shows the presets while the discount is being set, and not before', () => {
    expect(render().join('')).not.toContain('5%');
    const editing = render({ editing: true }).join('');
    expect(editing).toContain('5%');
    expect(editing).toContain('20%');
  });

  it('offers to take a discount back once one is on the line', () => {
    const withDiscount: CartLine = { ...line, manualDiscount: { type: 'percentage', value: 10 } };
    expect(render({ line: withDiscount, editing: true })).toContain('Remove');
  });
});
