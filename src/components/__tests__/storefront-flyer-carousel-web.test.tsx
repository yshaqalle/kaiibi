import { AccessibilityInfo, Platform, type EmitterSubscription } from 'react-native';
import { act, create } from 'react-test-renderer';

// Task 14's whole reason to exist: on a laptop, RN-web's horizontal
// ScrollView answers touch and a drag scrollbar but not a mouse. This file
// is split from storefront-flyer-carousel.test.tsx (rather than a describe
// block inside it) because `Platform.OS` is overridden here for the WHOLE
// file, the same device storefront-collect-wiring.test.tsx already uses for
// its own web-only assertions -- keeping it here means the main suite's 24
// tests stay proof that native (`Platform.OS === 'ios'`, Jest's own default)
// is untouched, rather than needing every one of them to defend against a
// mutable global that this file alone needs flipped.
Object.defineProperty(Platform, 'OS', { value: 'web', configurable: true });

import { FlyerCarousel } from '@/components/storefront/flyer-carousel';
import { paletteColors } from '@/lib/storefront-catalog';
import type { StorefrontFlyer } from '@/types/models';

jest.mock('@/lib/supabase', () => ({ supabase: {} }));
jest.mock('@/lib/external-url', () => ({ openExternalUrl: jest.fn() }));

const isReduceMotionEnabled = jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled');
jest.spyOn(AccessibilityInfo, 'addEventListener').mockReturnValue({ remove: jest.fn() } as unknown as EmitterSubscription);

beforeEach(() => {
  isReduceMotionEnabled.mockReset().mockResolvedValue(false);
});

const colors = paletteColors('ink');

function flyer(over: Partial<StorefrontFlyer> = {}): StorefrontFlyer {
  return {
    id: 'f1',
    imageUrl: 'https://cdn.example/shop/eid.jpg',
    headline: 'Eid stock has landed',
    subline: null,
    linkKind: 'none',
    linkValue: null,
    offer: null,
    ...over,
  };
}

// Same shape as storefront-flyer-carousel.test.tsx's own host-node walker --
// duplicated rather than shared, matching every other pair of storefront
// test files in this directory (none of them import a common test-utils
// module; each carries its own small reader).
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

function selectedIndex(tree: ReturnType<typeof create>): number {
  return withTestId(tree, 'storefront-flyer-dot').findIndex((dot) => (
    (dot.props.accessibilityState as { selected?: boolean } | undefined)?.selected
  ) === true);
}

async function render(flyers: StorefrontFlyer[]) {
  let tree!: ReturnType<typeof create>;
  await act(async () => {
    tree = create(
      <FlyerCarousel flyers={flyers} colors={colors} shopName="Xamdi Electronics" whatsappE164={null} />,
    );
  });
  return tree;
}

// FlyerCarousel measures its own width from `onLayout` (defaulting to the
// window width before that fires); react-test-renderer never calls layout
// handlers, so a real width has to be pushed in the same way every other
// storefront test that depends on it does -- by driving `onLayout` directly.
async function layout(tree: ReturnType<typeof create>, width: number) {
  const band = withTestId(tree, 'storefront-flyer-band')[0];
  await act(async () => {
    (band.props.onLayout as (e: { nativeEvent: { layout: { width: number } } }) => void)({
      nativeEvent: { layout: { width } },
    });
  });
}

function track(tree: ReturnType<typeof create>) {
  return withTestId(tree, 'storefront-flyer-track')[0];
}

describe('FlyerCarousel: web mouse (Task 14)', () => {
  const threeFlyers = () => [flyer({ id: 'f1' }), flyer({ id: 'f2' }), flyer({ id: 'f3' })];

  // The affordances exist as PROPS on the track only on web -- proof this is
  // "genuinely web-only" rather than something native happens to ignore.
  it('wires wheel and pointer handlers onto the track', async () => {
    const tree = await render(threeFlyers());
    const t = track(tree);
    expect(typeof t.props.onWheel).toBe('function');
    expect(typeof t.props.onPointerDown).toBe('function');
    expect(typeof t.props.onPointerMove).toBe('function');
    expect(typeof t.props.onPointerUp).toBe('function');
    expect(typeof t.props.onPointerCancel).toBe('function');
  });

  // Wheel-pan: a vertical delta scrolls the band, and the page must not
  // scroll behind it -- `preventDefault` is the whole of that second half.
  it('prevents the page from scrolling under a wheel gesture, and settles onto the nearest card', async () => {
    jest.useFakeTimers();
    try {
      const tree = await render(threeFlyers());
      await layout(tree, 300);
      expect(selectedIndex(tree)).toBe(0);

      const preventDefault = jest.fn();
      await act(async () => {
        (track(tree).props.onWheel as (e: unknown) => void)({ deltaX: 0, deltaY: 260, preventDefault });
      });
      expect(preventDefault).toHaveBeenCalled();

      // Settling is debounced -- see `handleWheel`'s own comment -- so the
      // dot has not moved yet immediately after the tick...
      expect(selectedIndex(tree)).toBe(0);
      // ...and has once the wheel has gone quiet.
      await act(async () => { jest.advanceTimersByTime(200); });
      expect(selectedIndex(tree)).toBe(1);
    } finally {
      jest.useRealTimers();
    }
  });

  // A single big leftward pan on a wide-enough delta should be able to
  // clear more than one card's width in one gesture -- proof the offset is
  // real pixel travel, not a "one wheel tick = one card" shortcut.
  it('pans by real pixel distance, not by a fixed step', async () => {
    jest.useFakeTimers();
    try {
      const tree = await render(threeFlyers());
      await layout(tree, 300);
      await act(async () => {
        (track(tree).props.onWheel as (e: unknown) => void)({ deltaX: 0, deltaY: 640, preventDefault: jest.fn() });
      });
      await act(async () => { jest.advanceTimersByTime(200); });
      // 640px against 300px-wide cards lands past card 1 -- clamped to the
      // last card (index 2), not stuck at 1.
      expect(selectedIndex(tree)).toBe(2);
    } finally {
      jest.useRealTimers();
    }
  });

  // Drag-to-grab is gated on `pointerType === 'mouse'` -- a touch pointer on
  // a touch-web device must fall straight through to the browser's own
  // native scrolling, untouched by any of this.
  it('ignores a touch pointer entirely', async () => {
    const tree = await render(threeFlyers());
    await layout(tree, 300);
    const t = track(tree);
    act(() => {
      (t.props.onPointerDown as (e: unknown) => void)({ pointerType: 'touch', pointerId: 1, clientX: 200 });
      (t.props.onPointerMove as (e: unknown) => void)({ clientX: 20 });
      (t.props.onPointerUp as (e: unknown) => void)({});
    });
    expect(selectedIndex(tree)).toBe(0);
  });

  // Drag-to-grab with a mouse: press, drag, and release settles on the
  // nearest card -- snap was suspended for the drag (`pagingEnabled` below),
  // so this settle is the only thing that puts the band back on a card.
  it('pans while a mouse drags, and settles on release', async () => {
    const tree = await render(threeFlyers());
    await layout(tree, 300);
    const t = track(tree);

    const setPointerCapture = jest.fn();
    act(() => {
      (t.props.onPointerDown as (e: unknown) => void)({
        pointerType: 'mouse', pointerId: 7, clientX: 200, currentTarget: { setPointerCapture },
      });
    });
    expect(setPointerCapture).toHaveBeenCalledWith(7);
    // Mid-drag: paging is suspended so a native snap cannot fight the drag.
    expect(track(tree).props.pagingEnabled).toBe(false);

    act(() => { (t.props.onPointerMove as (e: unknown) => void)({ clientX: -50 }); });
    act(() => { (t.props.onPointerUp as (e: unknown) => void)({}); });

    // Dragged left-to-right by 250px past a 300px card -- lands on card 1,
    // and paging resumes now that the gesture is over.
    expect(selectedIndex(tree)).toBe(1);
    expect(track(tree).props.pagingEnabled).toBe(true);
  });

  // Clicking a dot has worked since before Task 14 (goTo is unconditional);
  // this just pins that a web mount does not lose it. `toJSON()` only yields
  // HOST nodes, and Pressable's `onPress` lives on the composite instance
  // (it forwards `testID` down through a plain View, which carries no
  // `onPress` of its own) -- `tree.root.findAll` on the composite, filtered
  // to whichever instance actually carries the handler, is what
  // storefront-flyer-carousel.test.tsx's own `pressable()` helper does for
  // the same reason.
  it('still jumps to a card when its dot is pressed', async () => {
    const tree = await render(threeFlyers());
    const dot = tree.root.findAll((n) => n.props?.testID === 'storefront-flyer-dot' && typeof n.props?.onPress === 'function')[2];
    await act(async () => { (dot.props.onPress as () => void)(); });
    expect(selectedIndex(tree)).toBe(2);
  });

  // Hover-only arrows: hidden until the band is hovered, and only on web --
  // the `(hover: hover)` media query's RN-web equivalent.
  it('hides the arrows until the band is hovered, then reveals them', async () => {
    const tree = await render(threeFlyers());
    const arrowBefore = withTestId(tree, 'storefront-flyer-prev')[0];
    expect(flatten(arrowBefore.props.style).opacity).toBe(0);
    expect(arrowBefore.props.pointerEvents).toBe('none');

    const band = withTestId(tree, 'storefront-flyer-band')[0];
    await act(async () => { (band.props.onMouseEnter as () => void)(); });

    const arrowAfter = withTestId(tree, 'storefront-flyer-prev')[0];
    expect(flatten(arrowAfter.props.style).opacity).toBe(1);
    expect(arrowAfter.props.pointerEvents).toBe('auto');

    await act(async () => { (band.props.onMouseLeave as () => void)(); });
    expect(flatten(withTestId(tree, 'storefront-flyer-prev')[0].props.style).opacity).toBe(0);
  });
});
