import { Platform, StyleSheet } from 'react-native';
import { act, create } from 'react-test-renderer';

// The grid card's own hover-lift, tested the way storefront-product-tile-web.
// test.tsx and storefront-category-band-web.test.tsx already test theirs:
// `Platform.OS` overridden for the WHOLE file, so the main suite
// (storefront-directory.test.tsx) stays proof that native is untouched.
Object.defineProperty(Platform, 'OS', { value: 'web', configurable: true });

import { ShopDirectoryCard, resetDirectoryEnteredForTests } from '@/components/storefront/shop-directory-card';
import { paletteColors } from '@/lib/storefront-catalog';
import type { PublicShopSummary } from '@/types/models';

jest.mock('@/lib/supabase', () => ({ supabase: {} }));

const colors = paletteColors('ink');
const CARD = 'storefront-directory-card-dir-web';

const matchMedia = jest.fn().mockReturnValue({ matches: true });

beforeEach(() => {
  matchMedia.mockReset().mockReturnValue({ matches: true });
  (window as unknown as { matchMedia: typeof matchMedia }).matchMedia = matchMedia;
});

afterEach(() => {
  resetDirectoryEnteredForTests();
});

function summary(overrides: Partial<PublicShopSummary> = {}): PublicShopSummary {
  return {
    shopName: 'Web Hover Shop', slug: 'dir-web', city: 'Hargeisa',
    headline: null, about: null, heroImageUrl: null, offersDelivery: false,
    openingHours: {}, categories: ['Electronics'], productCount: 4,
    ...overrides,
  };
}

function render() {
  let tree!: ReturnType<typeof create>;
  act(() => {
    tree = create(<ShopDirectoryCard shop={summary()} colors={colors} onPress={jest.fn()} />);
  });
  return tree;
}

function flatten(style: unknown): Record<string, unknown> {
  return StyleSheet.flatten(style) as Record<string, unknown>;
}

describe("ShopDirectoryCard: web hover-lift, composed with press-feedback's own press-scale", () => {
  it('lifts the card on hover, on a device that can actually hover', () => {
    const tree = render();
    const card = tree.root.findAll((n) => n.props?.testID === CARD)[0];
    const styleFn = card.props.style as (s: { pressed: boolean }) => unknown;
    expect(flatten(styleFn({ pressed: false })).transform).toBeUndefined();

    act(() => { (card.props.onHoverIn as () => void)(); });
    const hovered = tree.root.findAll((n) => n.props?.testID === CARD)[0];
    const hoveredStyleFn = hovered.props.style as (s: { pressed: boolean }) => unknown;
    expect(flatten(hoveredStyleFn({ pressed: false })).transform).toEqual([{ translateY: -2 }]);

    act(() => { (hovered.props.onHoverOut as () => void)(); });
    const unhovered = tree.root.findAll((n) => n.props?.testID === CARD)[0];
    const unhoveredStyleFn = unhovered.props.style as (s: { pressed: boolean }) => unknown;
    expect(flatten(unhoveredStyleFn({ pressed: false })).transform).toBeUndefined();
  });

  // The same regression FIX 3 in category-band.tsx and product-tile.tsx guard
  // against: `Platform.OS === 'web'` is true in a phone's browser too, and
  // mobile WebKit/Chrome synthesise a hover event after a tap.
  it('never lifts the card on a device that cannot actually hover', () => {
    matchMedia.mockReturnValue({ matches: false });
    const tree = render();
    const card = tree.root.findAll((n) => n.props?.testID === CARD)[0];
    act(() => { (card.props.onHoverIn as () => void)(); });
    const afterHoverAttempt = tree.root.findAll((n) => n.props?.testID === CARD)[0];
    const styleFn = afterHoverAttempt.props.style as (s: { pressed: boolean }) => unknown;
    expect(flatten(styleFn({ pressed: false })).transform).toBeUndefined();
  });

  // THE COLLISION THIS CARD MUST NOT HAVE, proved on the SAME node a real
  // mouse-then-thumb interaction would hit: this card has no narrower node to
  // put a press-scale on (the whole card is one press target), so hover and
  // press land on the identical `Pressable` -- the exact shape
  // press-feedback.ts's own header comment warns collides, and the exact
  // shape CategoryTile's `tileHovered` still has NOT been fixed for
  // (category-band.tsx's own "KNOWN, NOT FIXED IN THIS PASS" comment). A test
  // that hovered one node and pressed a different one would prove nothing
  // about this defect -- it has to be the same node, hovered and then
  // pressed, in that order, which is what a real mouse-down-while-hovering
  // does.
  it('keeps the hover lift when the SAME node is also pressed, rather than losing it to press-scale', () => {
    const tree = render();
    const card = tree.root.findAll((n) => n.props?.testID === CARD)[0];
    act(() => { (card.props.onHoverIn as () => void)(); });

    const hovered = tree.root.findAll((n) => n.props?.testID === CARD)[0];
    const styleFn = hovered.props.style as (s: { pressed: boolean }) => unknown;

    // Hovered, not pressed: the lift alone.
    expect(flatten(styleFn({ pressed: false })).transform).toEqual([{ translateY: -2 }]);

    // Hovered AND pressed, on the SAME node -- both survive in one array,
    // rather than the press-scale replacing the whole `transform` key the
    // way RN's naive style flattening would.
    const pressedFlat = flatten(styleFn({ pressed: true }));
    expect(pressedFlat.transform).toEqual([{ translateY: -2 }, { scale: 0.97 }]);
    expect(pressedFlat.opacity).toBe(0.72);

    // Releasing the press (still hovered) restores the lift-only shape --
    // this is a style FUNCTION, not committed state, so calling it again
    // with `pressed: false` is exactly what RN does on press-out.
    expect(flatten(styleFn({ pressed: false })).transform).toEqual([{ translateY: -2 }]);
  });

  it('presses with only the scale when the card was never hovered at all', () => {
    const tree = render();
    const card = tree.root.findAll((n) => n.props?.testID === CARD)[0];
    const styleFn = card.props.style as (s: { pressed: boolean }) => unknown;
    const pressedFlat = flatten(styleFn({ pressed: true }));
    expect(pressedFlat.transform).toEqual([{ scale: 0.97 }]);
  });
});
