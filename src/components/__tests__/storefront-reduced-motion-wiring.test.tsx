import { act, create } from 'react-test-renderer';

// THE GAP THIS FILE CLOSES. Every motion decision on this branch --
// `heroRiseDelay`, `pillMotion`, `flyToCartMotion`, `slipBumpMotion`,
// `countUpDuration` -- is a pure, exported function, and every one of them is
// tested directly elsewhere (storefront-shop-tabs.test.tsx,
// storefront-fly-to-cart.test.ts). What none of those tests can see is the
// WIRING: that each consumer actually calls `useReducedMotion()` and actually
// passes what it returns into the decision, rather than dropping the
// argument, hard-coding it, or inverting it.
//
// `jest/reanimated-mock.js` hard-codes `useReducedMotion: () => false` for
// the whole suite (see that file's own comment), and the same mock renders
// `Animated.View` as a plain `View` and drops `entering` -- so no render-based
// assertion can tell a wired consumer from a broken one, in either
// reduced-motion state. A render-based version of this file existed once (see
// git history on this path) and was correctly deleted once Aurora's own
// loop-vs-static branch -- the one render difference reduced motion used to
// produce -- was removed; every remaining consumer's rendered output is
// already identical whether or not the wiring holds.
//
// THE SEAM: every decision function this file exercises is imported by its
// consumer from a DIFFERENT module than the one it's defined in (fly-to-cart.ts
// for slipBumpMotion/countUpDuration/flyToCartMotion) -- or, for heroRiseDelay
// and pillMotion, which a consumer calls from within their OWN file and so
// cannot be `jest.spyOn`'d through a module boundary (same-file calls in
// compiled CommonJS reference the local binding directly, never the
// module's `exports` object -- spying on the export does not intercept an
// internal caller), the consumer's own call into `react-native-reanimated`'s
// animation builders (`FadeInDown`, `withSpring`) IS the cross-module
// boundary instead. Both are spied at a real module seam, never inferred
// from what the tree renders.
//
// `jest.mock` here shadows the project's `moduleNameMapper` entry for
// `react-native-reanimated` for THIS FILE ONLY -- Jest's manual mocks take
// precedence over `moduleNameMapper` for a given specifier, and every other
// test file keeps resolving to the shared mock (reduced motion permanently
// off), so nothing here can leak into or change any other suite's baseline.
// `jest/reanimated-mock.js` itself is untouched.
//
// `mockReducedMotion` (the name matters: babel-plugin-jest-hoist only allows
// a factory to close over an out-of-scope identifier whose name starts with
// "mock", since jest.mock calls are hoisted above every other statement in
// the file) is flipped per test rather than the whole module being reset --
// resetting modules between "true" and "false" cases would hand
// react-test-renderer's tree a different copy of React than the one this
// file's own `react-test-renderer` import already holds, which breaks hooks
// in a way that has nothing to do with reduced motion.
let mockReducedMotion = false;

jest.mock('react-native-reanimated', () => {
  const Reanimated = jest.requireActual('react-native-reanimated/mock');
  return {
    ...Reanimated,
    useReducedMotion: () => mockReducedMotion,
    // `duration`/`delay` on the REAL mock's `FadeInDown` both return `this`
    // and accept anything -- fine for a component that just needs *an*
    // entering animation, useless for a test asking "was this called with
    // reduced motion's delay". Wrapped in jest.fn so the wiring test can read
    // what ShopAnchor actually passed in, `mockReturnThis` so the
    // `.duration(550).delay(delay)` chain in theme-shared.tsx keeps working
    // exactly as it does against the real mock.
    FadeInDown: {
      duration: jest.fn().mockReturnThis(),
      delay: jest.fn().mockReturnThis(),
    },
    // Real `withSpring` behaviour preserved (`callback?.(true); return
    // toValue;`) -- wrapped only so a test can see whether ShopTabRail ever
    // called it at all.
    withSpring: jest.fn(Reanimated.withSpring),
  };
});

// Same unblocking mock every storefront component test needs: theme-shared.tsx
// reaches '@/lib/storefront' -> '@/lib/storage' -> '@/lib/supabase', which
// constructs a real client at module load and throws without
// EXPO_PUBLIC_SUPABASE_*.
jest.mock('@/lib/supabase', () => ({ supabase: {} }));

// slipBumpMotion, countUpDuration (both consumed by CheckoutBar in
// theme-shared.tsx) and flyToCartMotion (consumed by FlyToCartLayer) are all
// defined in THIS module and imported into a different one -- a genuine
// cross-module boundary `jest.spyOn` can sit on. Wrapped around the REAL
// implementation (`jest.requireActual`) so every behaviour these functions'
// own dedicated tests (storefront-fly-to-cart.test.ts) already pin keeps
// working here too; only the call history is new.
jest.mock('@/components/storefront/fly-to-cart', () => {
  const actual = jest.requireActual('@/components/storefront/fly-to-cart');
  return {
    ...actual,
    slipBumpMotion: jest.fn(actual.slipBumpMotion),
    countUpDuration: jest.fn(actual.countUpDuration),
    flyToCartMotion: jest.fn(actual.flyToCartMotion),
  };
});

import { FadeInDown, withSpring } from 'react-native-reanimated';

import {
  CheckoutBar, ShopAnchor, resetHeroRisenForTests,
} from '@/components/storefront/theme-shared';
import { FlyToCartLayer } from '@/components/storefront/fly-to-cart-layer';
import { ShopTabRail } from '@/components/storefront/shop-tabs';
import {
  fireFlyToCart, flyToCartMotion, resetFlyToCartForTests, setSlipTarget, slipBumpMotion, countUpDuration,
} from '@/components/storefront/fly-to-cart';
import { paletteColors } from '@/lib/storefront-catalog';
import type { PublicStorefront } from '@/types/models';

const colors = paletteColors('ink');

afterEach(() => {
  jest.clearAllMocks();
  resetFlyToCartForTests();
  resetHeroRisenForTests();
});

function shop(overrides: Partial<PublicStorefront> = {}): PublicStorefront {
  return {
    shopName: 'Reduced Motion Store',
    city: 'Hargeisa',
    slug: 'reduced-motion-store',
    whatsappE164: null,
    theme: 'market',
    palette: 'ink',
    headline: null,
    about: null,
    heroImageUrl: null,
    offersDelivery: false,
    collectAddress: null,
    collectNeighborhood: null,
    paymentMode: 'on_collection',
    // Deliberately unconfigured -- ShopAnchor renders no open/closed pill
    // (and so no THIRD `riseIn` call) for a shop with no hours saved, which
    // keeps this fixture down to exactly the two `Animated.View`s (wordmark,
    // place) every test below counts on.
    openingHours: {},
    tradingSince: null,
    highlights: [],
    images: [],
    contactPhone: null,
    instagram: null,
    flyers: [],
    autoAdvance: false,
    hideBranding: false,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// THE HERO RISE. heroRiseDelay(reducedMotion, alreadyRisen, index) lives in
// theme-shared.tsx beside its only caller (ShopAnchor's own `riseIn`), so it
// cannot be spied on through a module boundary -- calling it from within the
// same file compiles to a direct reference to the local function, not to
// theme-shared's own `exports.heroRiseDelay`. What CAN be observed instead:
// `riseIn` either calls `FadeInDown.duration(550).delay(delay)` or it does
// not, and when it does, `delay` is exactly what heroRiseDelay decided. That
// is `react-native-reanimated`'s own animation-builder API, mocked above for
// this file only -- a real module seam, not an inference from render output.
// ─────────────────────────────────────────────────────────────────────────
describe('the hero rise: ShopAnchor wires useReducedMotion() into heroRiseDelay', () => {
  it('never touches FadeInDown when useReducedMotion() answers true', () => {
    mockReducedMotion = true;
    act(() => {
      create(<ShopAnchor storefront={shop({ slug: 'hero-rise-true' })} colors={colors} />);
    });
    expect(FadeInDown.duration).not.toHaveBeenCalled();
    expect(FadeInDown.delay).not.toHaveBeenCalled();
  });

  it('carries the computed per-line delay into FadeInDown when useReducedMotion() answers false', () => {
    mockReducedMotion = false;
    act(() => {
      create(<ShopAnchor storefront={shop({ slug: 'hero-rise-false' })} colors={colors} />);
    });
    // Wordmark (index 0, heroRiseDelay(false, false, 0) === 0) and place
    // (index 1, === 80) are the only two `Animated.View`s this fixture ever
    // mounts (openingHours: {} skips the pill's own, third one).
    expect(FadeInDown.duration).toHaveBeenCalledWith(550);
    expect(FadeInDown.delay).toHaveBeenCalledWith(0);
    expect(FadeInDown.delay).toHaveBeenCalledWith(80);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// THE CHECKOUT SLIP'S BUMP AND COUNT-UP. Unlike heroRiseDelay, slipBumpMotion
// and countUpDuration are defined in fly-to-cart.ts and imported into
// theme-shared.tsx -- a real cross-module boundary this file's own
// jest.mock('@/components/storefront/fly-to-cart', ...) sits on directly.
// ─────────────────────────────────────────────────────────────────────────
describe("the checkout slip: CheckoutBar wires useReducedMotion() into slipBumpMotion and countUpDuration", () => {
  function renderBar(subtotalCents: number, itemCount: number) {
    return (
      <CheckoutBar
        colors={colors}
        itemCount={itemCount}
        subtotalCents={subtotalCents}
        thumbnails={[null]}
        fulfilment={null}
        onPress={() => {}}
      />
    );
  }

  it('calls both with true when useReducedMotion() answers true', () => {
    mockReducedMotion = true;
    let tree!: ReturnType<typeof create>;
    // First mount only ever records the opening total (theme-shared.tsx's own
    // `everMounted` guard) -- the bump and count-up play on a CHANGE.
    act(() => { tree = create(renderBar(1000, 1)); });
    act(() => { tree.update(renderBar(1500, 2)); });
    expect(slipBumpMotion).toHaveBeenCalledWith(true);
    expect(countUpDuration).toHaveBeenCalledWith(true);
  });

  it('calls both with false when useReducedMotion() answers false', () => {
    mockReducedMotion = false;
    let tree!: ReturnType<typeof create>;
    act(() => { tree = create(renderBar(1000, 1)); });
    act(() => { tree.update(renderBar(1500, 2)); });
    expect(slipBumpMotion).toHaveBeenCalledWith(false);
    expect(countUpDuration).toHaveBeenCalledWith(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// THE FLYING DOT. flyToCartMotion is also defined in fly-to-cart.ts and
// imported into a different module (fly-to-cart-layer.tsx) -- the same
// cross-module seam the slip's bump uses.
// ─────────────────────────────────────────────────────────────────────────
describe('the flying dot: FlyToCartLayer wires useReducedMotion() into flyToCartMotion', () => {
  it('calls flyToCartMotion with true when useReducedMotion() answers true', () => {
    mockReducedMotion = true;
    act(() => { create(<FlyToCartLayer colors={colors} />); });
    // A registered target is required -- fireFlyToCart's own short-circuit
    // (`if (!target || ...)`) never even evaluates flyToCartMotion without
    // one, so a real Add press's coordinate is stood in for here.
    setSlipTarget({ x: 100, y: 400 });
    act(() => { fireFlyToCart({ x: 20, y: 20 }); });
    expect(flyToCartMotion).toHaveBeenCalledWith(true);
  });

  it('calls flyToCartMotion with false when useReducedMotion() answers false', () => {
    mockReducedMotion = false;
    act(() => { create(<FlyToCartLayer colors={colors} />); });
    setSlipTarget({ x: 100, y: 400 });
    act(() => { fireFlyToCart({ x: 20, y: 20 }); });
    expect(flyToCartMotion).toHaveBeenCalledWith(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// THE SLIDING TAB PILL. pillMotion, like heroRiseDelay, is defined in the
// same file as its only caller (shop-tabs.tsx's own ShopTabRail) and so
// cannot be spied on through a module boundary either. What CAN be seen:
// ShopTabRail calls `withSpring` (from `react-native-reanimated`, mocked
// above) exactly when pillMotion answers 'spring', and never when it answers
// 'snap'. The very first measurement always snaps regardless of reduced
// motion (nothing to travel from yet -- see pillMotion's own comment), so
// this drives a SECOND measurement, on a tab switch, to actually exercise the
// reduced-motion branch.
// ─────────────────────────────────────────────────────────────────────────
describe('the sliding tab pill: ShopTabRail wires useReducedMotion() into pillMotion', () => {
  function layOutBothTabs(tree: ReturnType<typeof create>) {
    const shopTab = tree.root.find(
      (n) => n.props?.testID === 'storefront-tab-shop' && typeof n.props?.onLayout === 'function',
    );
    const aboutTab = tree.root.find(
      (n) => n.props?.testID === 'storefront-tab-about' && typeof n.props?.onLayout === 'function',
    );
    // The active tab's own onLayout is what ordinarily fires first measurement
    // -- pillMotion(reducedMotion, true) is 'snap' either way, so this alone
    // proves nothing about the wiring; it only arms `hasMeasuredRef`.
    act(() => { shopTab.props.onLayout({ nativeEvent: { layout: { x: 0, width: 60 } } }); });
    // Caches About's own layout without moving the pill (About is not active
    // yet) -- read back below when the active tab switches to it.
    act(() => { aboutTab.props.onLayout({ nativeEvent: { layout: { x: 80, width: 70 } } }); });
  }

  it('never calls withSpring when useReducedMotion() answers true, even on a later tab switch', () => {
    mockReducedMotion = true;
    let tree!: ReturnType<typeof create>;
    act(() => {
      tree = create(<ShopTabRail colors={colors} tabs={['shop', 'about']} active="shop" onSelect={() => {}} />);
    });
    layOutBothTabs(tree);
    // The switch: `active` changing from 'shop' to 'about' re-runs
    // ShopTabRail's own effect, which reads About's now-cached layout and
    // calls `applyLayout` a SECOND time -- `hasMeasuredRef.current` is
    // already true, so this is the call that actually asks pillMotion about
    // reduced motion rather than "is this the first measurement".
    act(() => {
      tree.update(<ShopTabRail colors={colors} tabs={['shop', 'about']} active="about" onSelect={() => {}} />);
    });
    expect(withSpring).not.toHaveBeenCalled();
  });

  it('calls withSpring with the new tab position when useReducedMotion() answers false, on a later tab switch', () => {
    mockReducedMotion = false;
    let tree!: ReturnType<typeof create>;
    act(() => {
      tree = create(<ShopTabRail colors={colors} tabs={['shop', 'about']} active="shop" onSelect={() => {}} />);
    });
    layOutBothTabs(tree);
    act(() => {
      tree.update(<ShopTabRail colors={colors} tabs={['shop', 'about']} active="about" onSelect={() => {}} />);
    });
    expect(withSpring).toHaveBeenCalledWith(80, expect.objectContaining({ damping: 18, stiffness: 180 }));
  });
});
