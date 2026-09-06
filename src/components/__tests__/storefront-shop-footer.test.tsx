import { act, create } from 'react-test-renderer';

import { ShopFooter } from '@/components/storefront/shop-footer';
import { paletteColors } from '@/lib/storefront-catalog';
import type { PublicStorefront } from '@/types/models';

// shop-footer.tsx imports theme-shared.tsx (for WhatsAppButton), which
// transitively imports '@/lib/storefront' -> '@/lib/storage' ->
// '@/lib/supabase', which throws at import time without real Supabase env
// vars. Every existing test that imports theme-shared.tsx mocks this same
// module for the same reason (see storefront-checkout-bar.test.tsx).
jest.mock('@/lib/supabase', () => ({ supabase: {} }));

// `@testing-library/react-native` is not installed in this repo (see
// storefront-checkout-bar.test.tsx for the same pattern) -- use
// react-test-renderer's own tree instead of `render`/`screen`. The brief's
// `screen.getByTestId(x)` translates to a non-empty `findAll` for that
// testID, and `screen.queryByTestId(x)` being null translates to an empty
// `findAll` result.
const shop = (over: Partial<PublicStorefront> = {}): PublicStorefront =>
  ({
    shopName: 'Test Shop',
    city: 'Hargeisa',
    whatsappE164: null,
    hideBranding: false,
    ...over,
  }) as PublicStorefront;

const colors = paletteColors('ink');

function renderFooter(storefront: PublicStorefront) {
  let tree!: ReturnType<typeof create>;
  act(() => {
    tree = create(<ShopFooter storefront={storefront} colors={colors} />);
  });
  return tree;
}

describe('footer branding', () => {
  it('shows the mark on a plan that includes it', () => {
    const tree = renderFooter(shop());
    const mark = tree.root.findAll((node) => node.props?.testID === 'storefront-powered-by');
    expect(mark.length).toBeGreaterThan(0);
  });

  it('hides the mark when the plan buys it off', () => {
    const tree = renderFooter(shop({ hideBranding: true }));
    const mark = tree.root.findAll((node) => node.props?.testID === 'storefront-powered-by');
    expect(mark).toHaveLength(0);
  });
});
