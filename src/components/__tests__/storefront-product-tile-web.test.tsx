import { Platform, Pressable } from 'react-native';
import { act, create } from 'react-test-renderer';

// Task 17's own hover-lift, tested the way storefront-category-band-web.test.tsx
// already tests CategoryTile's identical affordance: `Platform.OS` overridden
// for the WHOLE file, so the main suite (storefront-product-tile.test.tsx)
// stays proof that native is untouched.
Object.defineProperty(Platform, 'OS', { value: 'web', configurable: true });

import { pressable } from '@/components/storefront/press-feedback';
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

  // ProductTile's own dodge of Task 15's defect: the hover lift lives on the
  // OUTER card, Add's press-scale lives on Add's OWN, separate node (see
  // product-tile.tsx's "NO COLLISION WITH PRESS-FEEDBACK, BY CONSTRUCTION"
  // comment). This is real and worth pinning -- a future edit that moved
  // Add's press style onto the card's own style array would break it -- but
  // it is NOT, on its own, a test of the collision itself: two style arrays
  // on two different nodes were never going to fight over one `transform`
  // key no matter what either one contains. The test below this one is what
  // actually exercises that.
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

  // THE COLLISION ITSELF (Task 15's own defect), reproduced on one real node
  // rather than inferred from two. Neither node in ProductTile's OWN tree
  // ever combines a hover style and press-feedback's press-scale in a
  // single style array -- that is the whole point of the split above -- so
  // there is no node in ProductTile to hover-and-press at once. This builds
  // the smallest node that DOES: a real `Pressable`, styled with the SAME
  // real `pressable()` helper every button on this page uses, whose base
  // style is `hovered && { transform: [{ translateY: -3 } ] }` -- the exact
  // shape ProductTile's own outer card would have if its hover lift and
  // Add's press-scale were EVER folded onto one node (which is exactly what
  // category-band.tsx's CategoryTile still does today, per its own
  // "KNOWN, NOT FIXED IN THIS PASS" comment -- this is that same shape,
  // pinned here where ProductTile's design explicitly depends on avoiding
  // it).
  it('confirms the failure mode this design avoids: on ONE node, a press-scale wipes a hover lift sharing its style array', () => {
    const hoveredStyle = pressable([{ transform: [{ translateY: -3 }] }]);
    let tree!: ReturnType<typeof create>;
    act(() => {
      tree = create(<Pressable testID="collision-node" style={hoveredStyle} />);
    });
    const node = tree.root.findByProps({ testID: 'collision-node' });
    const styleFn = node.props.style as (s: { pressed: boolean }) => unknown;

    // Hovered, not pressed: the lift alone.
    expect(flatten(styleFn({ pressed: false })).transform).toEqual([{ translateY: -3 }]);

    // Hovered AND pressed, on the SAME node: RN's style flattening does not
    // merge two style objects' `transform` ARRAYS element-wise -- it takes
    // the whole `transform` key from whichever object comes LAST and drops
    // the other entirely. `pressed: true` here nests the hover style inside
    // `[base, styles.pressed]` (press-feedback.ts's own `pressable()`), and
    // `styles.pressed`'s `transform: [{ scale: 0.97 }]` is what survives --
    // the hover lift is gone, not composed with the press-scale. This is
    // the exact defect Task 15 hit and the reason ProductTile's outer card
    // and Add button are two nodes rather than one.
    const pressedFlat = flatten(styleFn({ pressed: true }));
    expect(pressedFlat.transform).toEqual([{ scale: 0.97 }]);
    expect(pressedFlat.transform).not.toContainEqual({ translateY: -3 });

    // The way OUT of this, if a node ever genuinely needs both at once: one
    // style object owning a single `transform` array with BOTH operations
    // in it, never two objects each claiming the key. Asserted here so the
    // test proves survival is possible at all, not only that the naive path
    // loses it.
    expect(flatten({ transform: [{ translateY: -3 }, { scale: 0.97 }] }).transform)
      .toEqual([{ translateY: -3 }, { scale: 0.97 }]);
  });
});
