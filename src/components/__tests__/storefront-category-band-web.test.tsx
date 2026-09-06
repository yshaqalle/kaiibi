import { Platform } from 'react-native';
import { act, create } from 'react-test-renderer';

// Task 14's whole reason to exist, reused here (Task 15): on a laptop,
// RN-web's horizontal ScrollView answers touch and a drag scrollbar but not
// a mouse. Split into its own file for the same reason
// storefront-flyer-carousel-web.test.tsx is: `Platform.OS` is overridden for
// the WHOLE file here, so the main suite stays proof that native
// (`Platform.OS === 'ios'`, Jest's own default) is untouched.
Object.defineProperty(Platform, 'OS', { value: 'web', configurable: true });

import { CategoryBand } from '@/components/storefront/category-band';
import { paletteColors } from '@/lib/storefront-catalog';
import type { StorefrontCategory, StorefrontProduct } from '@/types/models';

// category-band.tsx reaches theme-shared.tsx (for ON_SCRIM_INK/MUTED), which
// reaches '@/lib/storefront' -> '@/lib/storage' -> '@/lib/supabase', which
// constructs the real client at module load and throws without
// EXPO_PUBLIC_SUPABASE_* -- same unblocking mock every other storefront
// component test carries.
jest.mock('@/lib/supabase', () => ({ supabase: {} }));

const colors = paletteColors('ink');

const matchMedia = jest.fn().mockReturnValue({ matches: true });

beforeEach(() => {
  matchMedia.mockReset().mockReturnValue({ matches: true });
  (window as unknown as { matchMedia: typeof matchMedia }).matchMedia = matchMedia;
});

const products: StorefrontProduct[] = [
  {
    id: '1', name: 'Oxford Shirt', description: null, category: 'Shirts', priceCents: 2200, stock: 4,
    imageUrl: 'https://cdn.example/shop/shirt.jpg',
  },
  { id: '2', name: 'Chino', description: null, category: 'Trousers', priceCents: 2800, stock: 4, imageUrl: null },
];

const categories: StorefrontCategory[] = [
  { name: 'Shirts', imageUrl: null, productCount: 3 },
  { name: 'Trousers', imageUrl: null, productCount: 3 },
];

type HostNode = { type: string; props: Record<string, unknown>; children: unknown[] | null };

function hostNodes(tree: ReturnType<typeof create>): HostNode[] {
  const out: HostNode[] = [];
  const walk = (node: unknown) => {
    if (!node || typeof node === 'string') return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    const host = node as HostNode;
    out.push(host);
    (host.children ?? []).forEach(walk);
  };
  walk(tree.toJSON() as unknown);
  return out;
}

function withTestId(tree: ReturnType<typeof create>, testID: string): HostNode[] {
  return hostNodes(tree).filter((node) => node.props?.testID === testID);
}

function flatten(style: unknown): Record<string, unknown> {
  return [style]
    .flat(Infinity)
    .filter(Boolean)
    .reduce((acc, s) => ({ ...(acc as object), ...(s as object) }), {}) as Record<string, unknown>;
}

function render() {
  let tree!: ReturnType<typeof create>;
  act(() => {
    tree = create(<CategoryBand categories={categories} products={products} colors={colors} active={null} onSelect={jest.fn()} />);
  });
  return tree;
}

describe('CategoryBand: web mouse (Task 14, reused)', () => {
  // The pointer affordances exist as PROPS on the scroller only on web --
  // proof this is genuinely web-only rather than something native happens to
  // ignore, same shape flyer-carousel.tsx's own equivalent test pins.
  it('wires drag-to-grab pointer handlers onto the scroller', () => {
    const tree = render();
    const scroller = hostNodes(tree).find((n) => typeof n.props?.onPointerDown === 'function');
    expect(scroller).toBeDefined();
    expect(typeof scroller!.props.onPointerMove).toBe('function');
    expect(typeof scroller!.props.onPointerUp).toBe('function');
    expect(typeof scroller!.props.onPointerCancel).toBe('function');
  });

  // Drag-to-grab is gated on `pointerType === 'mouse'` -- a touch pointer on
  // a touch-web device must fall straight through to the browser's own
  // native scrolling, untouched by any of this.
  it('ignores a touch pointer entirely', () => {
    const tree = render();
    const scroller = hostNodes(tree).find((n) => typeof n.props?.onPointerDown === 'function')!;
    const setPointerCapture = jest.fn();
    act(() => {
      (scroller.props.onPointerDown as (e: unknown) => void)({
        pointerType: 'touch', pointerId: 1, clientX: 200, currentTarget: { setPointerCapture },
      });
    });
    expect(setPointerCapture).not.toHaveBeenCalled();
  });

  // A mouse press captures the pointer and starts tracking a drag; a touch
  // pointer, above, never does. This is the seam handlePointerMove/Up read.
  it('captures the pointer on a mouse press', () => {
    const tree = render();
    const scroller = hostNodes(tree).find((n) => typeof n.props?.onPointerDown === 'function')!;
    const setPointerCapture = jest.fn();
    act(() => {
      (scroller.props.onPointerDown as (e: unknown) => void)({
        pointerType: 'mouse', pointerId: 7, clientX: 200, currentTarget: { setPointerCapture },
      });
    });
    expect(setPointerCapture).toHaveBeenCalledWith(7);
  });

  // Hover lift (docs/design/storefront-bold-motion-mockup.html's
  // `.catcard:hover`) -- armed by a real mouse, per-tile.
  it('lifts a tile on hover, on a device that can actually hover', () => {
    const tree = render();
    const before = withTestId(tree, 'storefront-category-Shirts')[0];
    expect(flatten(before.props.style).transform).toBeUndefined();

    const shirtsTile = tree.root.findAll(
      (n) => n.props?.testID === 'storefront-category-Shirts' && typeof n.props?.onHoverIn === 'function',
    )[0];
    act(() => { (shirtsTile.props.onHoverIn as () => void)(); });

    const after = withTestId(tree, 'storefront-category-Shirts')[0];
    expect(flatten(after.props.style).transform).toEqual([{ translateY: -2 }]);

    act(() => { (shirtsTile.props.onHoverOut as () => void)(); });
    expect(flatten(withTestId(tree, 'storefront-category-Shirts')[0].props.style).transform).toBeUndefined();
  });

  // FIX 3's regression, reused: `Platform.OS === 'web'` is true in a phone's
  // browser too, and mobile WebKit/Chrome synthesise `onHoverIn` after a tap
  // ("ghost hover"). `matchMedia('(hover: hover)')` reporting `false` here
  // stands in for a real touch-only browser -- the tile must not lift.
  it('never lifts a tile on a device that cannot actually hover', () => {
    matchMedia.mockReturnValue({ matches: false });
    const tree = render();
    const shirtsTile = tree.root.findAll(
      (n) => n.props?.testID === 'storefront-category-Shirts' && typeof n.props?.onHoverIn === 'function',
    )[0];
    act(() => { (shirtsTile.props.onHoverIn as () => void)(); });
    expect(flatten(withTestId(tree, 'storefront-category-Shirts')[0].props.style).transform).toBeUndefined();
  });
});
