import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { ShopAnchor } from '@/components/storefront/theme-shared';
import { paletteColors } from '@/lib/storefront-catalog';
import type { PublicStorefront } from '@/types/models';

// theme-shared.tsx transitively imports '@/lib/storefront' -> '@/lib/storage'
// -> '@/lib/supabase', which throws at import time without real Supabase env
// vars. Every existing test that imports theme-shared.tsx mocks this same
// module for the same reason (see storefront-checkout-bar.test.tsx).
jest.mock('@/lib/supabase', () => ({ supabase: {} }));

// `@testing-library/react-native` is not installed in this repo -- use
// react-test-renderer's own tree instead of `render`/`screen`, the same
// pattern storefront-checkout-bar.test.tsx and storefront-shop-footer.test.tsx
// use. `findAll` on a testID is this suite's `getByTestId`/`queryByTestId`.
function findAll(tree: ReactTestRenderer, testID: string) {
  return tree.root.findAll((node) => node.props?.testID === testID);
}

const colors = paletteColors('ink');

// Every field PublicStorefront requires, with an unconfigured week and no
// photo -- the two "say nothing" defaults this suite overrides one at a time.
function shop(over: Partial<PublicStorefront> = {}): PublicStorefront {
  return {
    shopName: 'Hargeisa Men’s Clothing Store',
    city: 'Hargeisa',
    slug: 'hargeisa-mens',
    whatsappE164: null,
    theme: 'market',
    palette: 'ink',
    headline: null,
    about: null,
    heroImageUrl: null,
    offersDelivery: false,
    collectAddress: null,
    collectNeighborhood: null,
    openingHours: {},
    tradingSince: null,
    highlights: [],
    images: [],
    contactPhone: null,
    instagram: null,
    paymentMode: 'on_collection',
    flyers: [],
    autoAdvance: false,
    hideBranding: false,
    ...over,
  };
}

function renderAnchor(storefront: PublicStorefront) {
  let tree!: ReturnType<typeof create>;
  act(() => {
    tree = create(<ShopAnchor storefront={storefront} colors={colors} />);
  });
  return tree;
}

// A fresh slug per test that touches the "once per mount" cache, so one
// test's mount does not spend the module-level flag another test then reads
// as "already risen" -- see HERO_RISEN in theme-shared.tsx. Real shops never
// collide on a slug either, which is the same property this relies on.
let slugCounter = 0;
function freshSlug(): string {
  slugCounter += 1;
  return `test-shop-${slugCounter}`;
}

describe('the hero scrim -- the fix-class for the grey-shape defect', () => {
  it('renders the gradient scrim when a photo is present', () => {
    const tree = renderAnchor(shop({ slug: freshSlug(), heroImageUrl: 'https://example.com/shop.jpg' }));
    // Greater-than-zero, not exactly one -- react-test-renderer's `findAll`
    // walks both the composite `LinearGradient` and the native host node it
    // renders, and both carry the same testID (the pattern
    // storefront-shop-footer.test.tsx already uses for the identical reason).
    expect(findAll(tree, 'storefront-hero-scrim').length).toBeGreaterThan(0);
  });

  // THE DEFECT ITSELF: a grey shape used to appear over the no-photo
  // fallback. Pinning that the scrim never renders without a photo is the
  // whole of what this test exists for.
  it('never renders a scrim over the no-photo fallback', () => {
    const tree = renderAnchor(shop({ slug: freshSlug(), heroImageUrl: null }));
    expect(findAll(tree, 'storefront-hero-scrim')).toHaveLength(0);
  });
});

describe('the open-state pill', () => {
  it('renders nothing when the shop has never set hours', () => {
    const tree = renderAnchor(shop({ slug: freshSlug(), openingHours: {} }));
    expect(findAll(tree, 'storefront-anchor-open-pill')).toHaveLength(0);
  });

  it('says Open now, filled with the accent, at a configured open hour', () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-07T10:00:00')); // a Monday, 10am
    try {
      const tree = renderAnchor(
        shop({ slug: freshSlug(), openingHours: { mon: [{ open: '08:00', close: '18:00' }] } }),
      );
      const pills = findAll(tree, 'storefront-anchor-open-pill');
      expect(pills.length).toBeGreaterThan(0);
      expect(pills[0].props.style).toEqual(
        expect.arrayContaining([expect.objectContaining({ backgroundColor: colors.accent })]),
      );
      const texts = tree.root.findAll((node) => Array.isArray(node.children) && node.children.includes('Open now'));
      expect(texts.length).toBeGreaterThan(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it('says Closed now, filled with soft, outside the configured hours -- word and fill together', () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-07T22:00:00')); // a Monday, 10pm
    try {
      const tree = renderAnchor(
        shop({ slug: freshSlug(), openingHours: { mon: [{ open: '08:00', close: '18:00' }] } }),
      );
      const pills = findAll(tree, 'storefront-anchor-open-pill');
      expect(pills.length).toBeGreaterThan(0);
      expect(pills[0].props.style).toEqual(
        expect.arrayContaining([expect.objectContaining({ backgroundColor: colors.soft })]),
      );
      const texts = tree.root.findAll((node) => Array.isArray(node.children) && node.children.includes('Closed now'));
      expect(texts.length).toBeGreaterThan(0);
    } finally {
      jest.useRealTimers();
    }
  });
});
