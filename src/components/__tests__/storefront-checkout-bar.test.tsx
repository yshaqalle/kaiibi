import { act, create, type ReactTestRendererJSON } from 'react-test-renderer';

import { CheckoutBar } from '@/components/storefront/theme-shared';
import { paletteColors } from '@/lib/storefront-catalog';

// theme-shared.tsx transitively imports '@/lib/storefront' -> '@/lib/storage'
// -> '@/lib/supabase', which throws at import time without real Supabase env
// vars. Every existing test that imports theme-shared.tsx mocks this same
// module for the same reason (see storefront-theme-market.test.tsx).
jest.mock('@/lib/supabase', () => ({ supabase: {} }));

// `@testing-library/react-native` is not installed in this repo (see
// storefront-cart-sheet.test.tsx for the same pattern) -- flatten the
// rendered tree to strings instead of reaching for a query library the repo
// does not have. The brief's own `render`/`screen` calls translate 1:1:
// `screen.getByText(x)` -> `texts.toContain(x)`, and
// `screen.queryByTestId(...)` being null -> the component's own toJSON()
// being null, since CheckoutBar returns null itself at itemCount === 0.
function textsIn(node: ReactTestRendererJSON | ReactTestRendererJSON[] | string | null): string[] {
  if (node == null) return [];
  if (typeof node === 'string') return [node];
  if (Array.isArray(node)) return node.flatMap(textsIn);
  return textsIn(node.children as ReactTestRendererJSON[] | null);
}

const colors = paletteColors('ink');
const noop = () => {};

function renderBar(props: {
  itemCount: number;
  subtotalCents: number;
  thumbnails: (string | null)[];
  fulfilment: string | null;
}) {
  let tree!: ReturnType<typeof create>;
  act(() => {
    tree = create(<CheckoutBar colors={colors} onPress={noop} {...props} />);
  });
  return tree;
}

describe('the checkout slip', () => {
  it('renders nothing with an empty cart', () => {
    const tree = renderBar({ itemCount: 0, subtotalCents: 0, thumbnails: [], fulfilment: null });
    expect(tree.toJSON()).toBeNull();
  });

  it('carries the evidence: total, count and fulfilment', () => {
    const tree = renderBar({
      itemCount: 3, subtotalCents: 11297, thumbnails: [null, null, null], fulfilment: 'collection',
    });
    const texts = textsIn(tree.toJSON() as ReactTestRendererJSON);
    expect(texts).toContain('$112.97');
    expect(texts).toContain('3 items · collection');
    expect(texts).toContain('Checkout');
  });

  it('says item, singular, and drops the fulfilment word when null', () => {
    const tree = renderBar({ itemCount: 1, subtotalCents: 1800, thumbnails: [null], fulfilment: null });
    const texts = textsIn(tree.toJSON() as ReactTestRendererJSON);
    expect(texts).toContain('1 item');
  });
});
