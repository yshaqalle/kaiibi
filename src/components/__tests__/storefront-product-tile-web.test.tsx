import { Platform } from 'react-native';
import { act, create } from 'react-test-renderer';

// Task 17's own hover-lift, tested the way storefront-category-band-web.test.tsx
// already tests CategoryTile's identical affordance: `Platform.OS` overridden
// for the WHOLE file, so the main suite (storefront-product-tile.test.tsx)
// stays proof that native is untouched.
Object.defineProperty(Platform, 'OS', { value: 'web', configurable: true });

import { ProductTile } from '@/components/storefront/product-tile';
import { paletteColors } from '@/lib/storefront-catalog';
import type { StorefrontProduct } from '@/types/models';

jest.mock('@/lib/supabase', () => ({ supabase: {} }));
jest.mock('@/lib/external-url', () => ({ openExternalUrl: jest.fn() }));

const colors = paletteColors('ink');

const matchMedia = jest.fn().mockReturnValue({ matches: true });

beforeEach(() => {
  matchMedia.mockReset().mockReturnValue({ matches: true });
  (window as unknown as { matchMedia: typeof matchMedia }).matchMedia = matchMedia;
});

const product: StorefrontProduct = {
  id: 'p1', name: 'Anker 20W charger', description: null, category: 'Phone', priceCents: 1200, stock: 5, imageUrl: null,
};

function flatten(style: unknown): Record<string, unknown> {
  return [style]
    .flat(Infinity)
    .filter(Boolean)
    .reduce((acc, s) => ({ ...(acc as object), ...(s as object) }), {}) as Record<string, unknown>;
}

function render() {
  let tree!: ReturnType<typeof create>;
  act(() => {
    tree = create(<ProductTile product={product} colors={colors} onAdd={jest.fn()} />);
  });
  return tree;
}

describe('ProductTile: web hover-lift (Task 17)', () => {
  it('lifts the card on hover, on a device that can actually hover', () => {
    const tree = render();
    const tile = tree.root.findAll((n) => n.props?.testID === 'product-tile')[0];
    expect(flatten(tile.props.style).transform).toBeUndefined();

    act(() => { (tile.props.onMouseEnter as () => void)(); });
    const hovered = tree.root.findAll((n) => n.props?.testID === 'product-tile')[0];
    expect(flatten(hovered.props.style).transform).toEqual([{ translateY: -3 }]);

    act(() => { (hovered.props.onMouseLeave as () => void)(); });
    const unhovered = tree.root.findAll((n) => n.props?.testID === 'product-tile')[0];
    expect(flatten(unhovered.props.style).transform).toBeUndefined();
  });

  // FIX 3's regression, reused (see storefront-category-band-web.test.tsx's
  // identical test): `Platform.OS === 'web'` is true in a phone's browser
  // too, and mobile WebKit/Chrome synthesise a hover event after a tap.
  it('never lifts the card on a device that cannot actually hover', () => {
    matchMedia.mockReturnValue({ matches: false });
    const tree = render();
    const tile = tree.root.findAll((n) => n.props?.testID === 'product-tile')[0];
    expect(tile.props.onMouseEnter).toBeUndefined();
  });

  // THE COLLISION THIS TASK'S BRIEF NAMES BY NUMBER (Task 15's own defect):
  // hovering the card and pressing its Add button at once must not have one
  // transform wipe the other -- which is exactly what happens when both
  // share a single style array on a single node. Proving that requires
  // showing the hover transform (on the OUTER card) survives independently
  // of whatever press-feedback does to the Add button's OWN, separate node.
  it('keeps the hover lift and Add\'s own press-scale on two different nodes, so neither transform can wipe the other', () => {
    const tree = render();
    const tile = tree.root.findAll((n) => n.props?.testID === 'product-tile')[0];
    act(() => { (tile.props.onMouseEnter as () => void)(); });

    const hoveredTile = tree.root.findAll((n) => n.props?.testID === 'product-tile')[0];
    expect(flatten(hoveredTile.props.style).transform).toEqual([{ translateY: -3 }]);

    // Add's own press-feedback style is a FUNCTION (press-feedback.ts) --
    // calling it with `{ pressed: true }` is what a real press-in produces,
    // entirely independent of the hovered tile's own style above.
    const add = tree.root.findAll((n) => n.props?.testID === 'product-tile-add')[0];
    expect(typeof add.props.style).toBe('function');
    const pressedAddStyle = flatten((add.props.style as (s: { pressed: boolean }) => unknown)({ pressed: true }));
    expect(pressedAddStyle.transform).toEqual([{ scale: 0.97 }]);

    // The hover lift is still exactly where it was -- the Add button being
    // pressed never touched the card's own node.
    const stillHoveredTile = tree.root.findAll((n) => n.props?.testID === 'product-tile')[0];
    expect(flatten(stillHoveredTile.props.style).transform).toEqual([{ translateY: -3 }]);
  });
});
