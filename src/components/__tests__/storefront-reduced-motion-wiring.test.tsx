import { act, create, type ReactTestRenderer } from 'react-test-renderer';

// THE GAP THIS FILE CLOSES. `jest/reanimated-mock.js` hard-codes
// `useReducedMotion: () => false` for the whole suite, and nothing overrides
// it anywhere else -- grepping `__tests__` for `reducedMotion` before this
// file turned up plenty of tests exercising the PURE decision functions
// (`heroRiseDelay`, `auroraMotion`, `pillMotion`, `flyToCartMotion`,
// `slipBumpMotion`, `countUpDuration`) directly, and none rendering a
// component with the hook itself answering `true`. Those pure functions are
// right, but nothing proved the WIRING from `useReducedMotion()` into a
// consumer prop was still connected -- inverting Aurora's own
// `reducedMotion={reducedMotion}` (theme-shared.tsx's ShopAnchor), or
// dropping the prop, would leave the whole suite green.
//
// `jest.mock` here shadows the project's `moduleNameMapper` entry for
// `react-native-reanimated` for THIS FILE ONLY -- Jest's manual mocks take
// precedence over `moduleNameMapper` for a given specifier, and every other
// test file keeps resolving to the shared mock (reduced motion off), so this
// cannot leak into or change any other suite's baseline.
jest.mock('react-native-reanimated', () => {
  const Reanimated = require('react-native-reanimated/mock');
  return { ...Reanimated, useReducedMotion: () => true };
});

// Same unblocking mock every storefront component test needs: theme-shared.tsx
// (ShopAnchor lives there) reaches '@/lib/storefront' -> '@/lib/storage' ->
// '@/lib/supabase', which constructs a real client at module load and throws
// without EXPO_PUBLIC_SUPABASE_*.
jest.mock('@/lib/supabase', () => ({ supabase: {} }));

import { ShopAnchor } from '@/components/storefront/theme-shared';
import { paletteColors } from '@/lib/storefront-catalog';
import type { PublicStorefront } from '@/types/models';

const colors = paletteColors('ink');

const photolessShop: PublicStorefront = {
  shopName: 'Reduced Motion Store',
  city: 'Hargeisa',
  slug: 'reduced-motion-store',
  whatsappE164: null,
  theme: 'market',
  palette: 'ink',
  headline: null,
  about: null,
  // No hero photo -- ShopAnchor's `onPhoto` is false, which is the one
  // branch that ever mounts <Aurora/> at all (theme-shared.tsx's own
  // `onPhoto ? <photo scrim/> : <Aurora .../>`).
  heroImageUrl: null,
  offersDelivery: false,
  collectAddress: null,
  collectNeighborhood: null,
  paymentMode: 'on_collection',
  openingHours: { mon: [{ open: '08:00', close: '18:00' }] },
  tradingSince: null,
  highlights: [],
  images: [],
  contactPhone: null,
  instagram: null,
  flyers: [],
  autoAdvance: false,
  hideBranding: false,
};

// WHY AURORA, OF EVERY CONSUMER: it is the one place `useReducedMotion()`'s
// result decides which of two STRUCTURALLY DIFFERENT trees mounts --
// `storefront-aurora` (three looping blobs) vs `storefront-aurora-static`
// (one still wash) -- rather than merely which timing config an animation
// that resolves synchronously under this mock ends up playing. Every other
// motion consumer on this branch (the hero's `FadeInDown` rise,
// FlyToCartLayer's arc, CheckoutBar's bump/count-up) either has its
// `entering` prop discarded outright by this same mock (see
// jest/reanimated-mock.js's own comment) or drives a `withTiming` whose
// completion callback fires SYNCHRONOUSLY under the shared mock -- both
// shapes collapse to the same final rendered state whether or not reduced
// motion is on, which is exactly why those consumers are covered by the
// pure functions instead. Aurora's branch is a plain `if` in the component
// body, decided once at render from `auroraMotion`'s result, so it is
// observable through nothing more than `toJSON()` -- no animation frame,
// synchronous or otherwise, has to resolve for the test to see it.
describe('reduced motion, wired all the way through: Aurora renders the static wash, not the loop', () => {
  it('mounts the single static blob and never the three-blob loop when useReducedMotion() answers true', async () => {
    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = create(<ShopAnchor storefront={photolessShop} colors={colors} />);
    });
    const statik = tree.root.findAll((n) => n.props?.testID === 'storefront-aurora-static');
    const loop = tree.root.findAll((n) => n.props?.testID === 'storefront-aurora');
    expect(statik.length).toBeGreaterThan(0);
    expect(loop).toHaveLength(0);
  });
});
