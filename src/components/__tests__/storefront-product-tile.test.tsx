import { act, create, type ReactTestRendererJSON } from 'react-test-renderer';

import { ProductTile } from '@/components/storefront/product-tile';
import { openExternalUrl } from '@/lib/external-url';
import { waLink } from '@/lib/storefront';
import { paletteColors } from '@/lib/storefront-catalog';
import type { StorefrontProduct } from '@/types/models';

// product-tile.tsx now imports waLink from '@/lib/storefront' for Ask, which
// transitively imports '@/lib/supabase' -- that throws at import time without
// real env vars. Same mock storefront-theme-counter.test.tsx already carries
// for the same reason.
jest.mock('@/lib/supabase', () => ({ supabase: {} }));
jest.mock('@/lib/external-url', () => ({ openExternalUrl: jest.fn() }));

const openMock = openExternalUrl as jest.MockedFunction<typeof openExternalUrl>;
beforeEach(() => openMock.mockReset());

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

function renderTile(product: StorefrontProduct, extra?: { whatsappE164?: string; shopName?: string }) {
  let tree!: ReturnType<typeof create>;
  act(() => {
    tree = create(<ProductTile product={product} colors={colors} {...extra} />);
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
    expect(texts).toContain('Out of stock');
  });

  it('says in stock when there is stock', () => {
    const texts = renderTile(base);
    expect(texts).toContain('In stock');
  });

  it('shows Add when in stock and calls onAdd with the product on press', () => {
    const onAdd = jest.fn();
    let tree!: ReturnType<typeof create>;
    act(() => {
      tree = create(<ProductTile product={base} colors={colors} onAdd={onAdd} />);
    });
    const texts = textsIn(tree.toJSON() as ReactTestRendererJSON);
    expect(texts).toContain('Add');

    const addButtons = tree.root.findAll((node) => node.props?.testID === 'product-tile-add');
    act(() => addButtons[0].props.onPress());
    expect(onAdd).toHaveBeenCalledWith(base);
  });

  // The shop may be restocking, and that enquiry is a sale -- an out-of-stock
  // tile loses Add but must never lose Ask or disappear.
  it('loses Add but keeps Ask when out of stock', () => {
    // The shop may be restocking, and that enquiry is a sale.
    const texts = renderTile({ ...base, stock: 0 }, { whatsappE164: '+252634418820' });
    expect(texts).not.toContain('Add');
    expect(texts).toContain('Ask');
    expect(texts).toContain('Out of stock');
  });

  it('shows Ask alongside Add when in stock', () => {
    const texts = renderTile(base, { whatsappE164: '+252634418820' });
    expect(texts).toContain('Ask');
    expect(texts).toContain('Add');
  });

  it('Ask opens a wa.me link prefilled with the shop and product name', () => {
    let tree!: ReturnType<typeof create>;
    act(() => {
      tree = create(
        <ProductTile product={base} colors={colors} shopName="Deka Electronics" whatsappE164="+252634418820" />
      );
    });
    const askButtons = tree.root.findAll((node) => node.props?.testID === 'product-tile-ask');
    act(() => askButtons[0].props.onPress());

    const expected = waLink('+252634418820', 'Hi Deka Electronics, is Anker 20W charger available?');
    expect(openMock).toHaveBeenCalledWith(expected);
  });

  // Commit 302630a changed Ask from "stays visible but inert without a
  // number" to hiding itself outright, deliberately -- asserted below.
  it('does not render Ask at all when the shop has no WhatsApp number', () => {
    // Matches WhatsAppButton in theme-shared: lose the button rather than
    // render one that opens a chat with nobody. An Ask that renders and
    // silently does nothing is the worse half of both options -- the customer
    // taps and the app shrugs. Publishing requires a number, so this is the
    // belt to that braces.
    let tree!: ReturnType<typeof create>;
    act(() => {
      tree = create(<ProductTile product={base} colors={colors} />);
    });
    const askButtons = tree.root.findAll((node) => node.props?.testID === 'product-tile-ask');
    expect(askButtons).toHaveLength(0);
    expect(openMock).not.toHaveBeenCalled();
  });
});
