import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import {
  heroHasRisen, heroRiseDelay, markHeroRisen, resetHeroRisenForTests, ShopAnchor,
} from '@/components/storefront/theme-shared';
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

// THE RISE'S DECISION -- heroRiseDelay, heroHasRisen, markHeroRisen and
// resetHeroRisenForTests exist because jest/reanimated-mock.js renders
// Animated.View as a plain View and drops `entering` entirely (see that
// file's own comment): no test that only renders ShopAnchor can tell a rise
// that played from one that didn't. These tests hold the decision directly,
// as arguments and a return value, rather than inferring it from a render.
describe('heroRiseDelay -- the hero rise decision', () => {
  it('under reduced motion, every line skips the rise regardless of index', () => {
    for (const index of [0, 1, 2, 3]) {
      expect(heroRiseDelay(true, false, index)).toBeNull();
      // Reduced motion wins even for a shop that has never risen before --
      // an inverted branch (animating ONLY under reduced motion) would fail
      // this the moment `alreadyRisen` is false.
      expect(heroRiseDelay(true, true, index)).toBeNull();
    }
  });

  it('reduced motion off, first time for this shop, animates with the staggered delay', () => {
    expect(heroRiseDelay(false, false, 0)).toBe(0);
    expect(heroRiseDelay(false, false, 1)).toBe(80);
    expect(heroRiseDelay(false, false, 2)).toBe(160);
  });

  it('reduced motion off, second time for the same shop, does not animate', () => {
    for (const index of [0, 1, 2]) {
      expect(heroRiseDelay(false, true, index)).toBeNull();
    }
  });
});

// THE SESSION CACHE ITSELF, driven through the real HERO_RISEN store via its
// two named seams -- not hand-fed booleans -- so a bug in the cache's own
// keying (the wrong slug, or marking risen under reduced motion) would show
// up here even though heroRiseDelay's own tests above cannot see it.
describe('the hero-risen cache (heroHasRisen / markHeroRisen)', () => {
  beforeEach(() => {
    resetHeroRisenForTests();
  });

  it('a shop starts unrisen, and marking it risen is observable on the same slug', () => {
    expect(heroHasRisen('shop-a')).toBe(false);
    markHeroRisen('shop-a');
    expect(heroHasRisen('shop-a')).toBe(true);
  });

  it('a different shop is unaffected by the first shop having risen', () => {
    markHeroRisen('shop-a');
    expect(heroHasRisen('shop-a')).toBe(true);
    expect(heroHasRisen('shop-b')).toBe(false);
  });

  it('composes with heroRiseDelay exactly as ShopAnchor does: risen once, then never again', () => {
    const slug = 'shop-c';
    // First mount: not yet risen, reduced motion off -> animates.
    expect(heroRiseDelay(false, heroHasRisen(slug), 0)).toBe(0);
    markHeroRisen(slug); // what ShopAnchor's effect does after that mount commits
    // Second mount, same shop: already risen -> does not animate again.
    expect(heroRiseDelay(false, heroHasRisen(slug), 0)).toBeNull();
    // A different shop, never having risen, still gets its own rise.
    expect(heroRiseDelay(false, heroHasRisen('shop-d'), 0)).toBe(0);
  });
});

// THE COMPONENT OBEYING THE DECISION, end to end: ShopAnchor mounted twice
// for the same slug marks the second mount's hero as already risen. This
// cannot observe the animation itself (the mock discards `entering`), but it
// does prove the wiring between ShopAnchor and the cache -- that `slug` is
// the key, and that a second mount reads what the first mount's effect wrote.
describe('ShopAnchor and the hero-risen cache, wired together', () => {
  beforeEach(() => {
    resetHeroRisenForTests();
  });

  it('a fresh slug has not risen before the first mount, and has after it', () => {
    const slug = freshSlug();
    expect(heroHasRisen(slug)).toBe(false);
    renderAnchor(shop({ slug }));
    expect(heroHasRisen(slug)).toBe(true);
  });

  it('mounting the same slug twice only spends the rise once', () => {
    const slug = freshSlug();
    renderAnchor(shop({ slug }));
    expect(heroHasRisen(slug)).toBe(true);
    // A second mount for the identical slug -- e.g. leaving Shop for About
    // and coming back -- must not un-spend the rise it already recorded.
    renderAnchor(shop({ slug }));
    expect(heroHasRisen(slug)).toBe(true);
  });
});
