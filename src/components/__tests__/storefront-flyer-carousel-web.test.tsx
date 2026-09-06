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

// `supportsHover` (Fix 3, flyer-carousel.tsx) reads `window.matchMedia
// ('(hover: hover)').matches` once, at mount, to decide whether the
// hover-revealed arrows can ever be armed at all. Defaults to `true` here --
// a real mouse -- since this whole file is "web mouse" behaviour; the one
// test below that needs a device WITHOUT real hover (a phone's browser,
// where `onMouseEnter`/`onHoverIn` still fire as a "ghost hover" after a
// tap) overrides it to `false` for just that render.
const matchMedia = jest.fn().mockReturnValue({ matches: true });

beforeEach(() => {
  isReduceMotionEnabled.mockReset().mockResolvedValue(false);
  matchMedia.mockReset().mockReturnValue({ matches: true });
  (window as unknown as { matchMedia: typeof matchMedia }).matchMedia = matchMedia;
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

  // The pointer affordances exist as PROPS on the track only on web -- proof
  // this is "genuinely web-only" rather than something native happens to
  // ignore. `onWheel` is deliberately NOT asserted here any more (it used
  // to be, before this fix) -- see the block comment below for why, and
  // storefront-flyer-carousel.test.tsx's own `wheelPanDelta`/`clampOffset`/
  // `nextWheelOffset`/`nearestIndex` suites for where the arithmetic that
  // used to be exercised through it is still covered.
  it('wires pointer handlers onto the track', async () => {
    const tree = await render(threeFlyers());
    const t = track(tree);
    expect(typeof t.props.onPointerDown).toBe('function');
    expect(typeof t.props.onPointerMove).toBe('function');
    expect(typeof t.props.onPointerUp).toBe('function');
    expect(typeof t.props.onPointerCancel).toBe('function');
  });

  // FIX (this pass): a JSX `onWheel` prop on <ScrollView> used to be how
  // `handleWheel` got called, and USED to be the seam these tests drove it
  // through -- but a plain JSX `onWheel` is exactly the defect: React
  // routes it through its own root-delegated, `{ passive: true }` listener
  // (confirmed in this repo's own installed react-dom,
  // node_modules/react-dom/cjs/react-dom-client.development.js's
  // WHEEL_EVENT_IS_PASSIVE handling), which makes `event.preventDefault()`
  // inside it a silent no-op -- so the band panned, but the page behind it
  // kept scrolling too, exactly what this whole affordance exists to
  // prevent. The old two tests here proved only that `handleWheel` ran when
  // handed a plain object directly; they never went through a real,
  // passively-attached listener, so neither could ever have caught this.
  //
  // The fix moves the listener off `onWheel` entirely and onto a real
  // `addEventListener('wheel', ..., { passive: false })`, attached directly
  // to the scrollable DOM node (see flyer-carousel.tsx's own comment on the
  // effect, right above `handlePointerDown`). That is genuinely
  // untestable here: `scroller.current` under this Jest harness (the
  // `react-native` package's own jest preset, not react-native-web, even
  // with `Platform.OS` forced to `'web'` for this file) is a plain RN
  // `ScrollView` class instance -- confirmed by probing it directly -- with
  // no `addEventListener` at all, and no `createNodeMock` intervenes,
  // because a class-component ref never reaches the host-mocking path
  // `createNodeMock` covers. There is no real DOM node this suite can ever
  // dispatch a wheel event at or spy an `addEventListener` call on. Per the
  // brief for this fix: rather than write a test that LOOKS like it covers
  // the passive-listener defect but cannot actually observe it (exactly the
  // shape of the two tests this replaces), this is left uncovered by an
  // integration test and said so plainly here -- the pure arithmetic
  // (`wheelPanDelta`, `clampOffset`, `nextWheelOffset`, `nearestIndex`) the
  // removed tests exercised indirectly stays covered directly, in
  // storefront-flyer-carousel.test.tsx, which this fix did not touch.

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
  // the `(hover: hover)` media query's RN-web equivalent. `matchMedia`
  // reports a real mouse here (the `beforeEach` default), which is what
  // lets a genuine `onMouseEnter` arm them.
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

  // FIX 3: the regression this whole gate exists for. `Platform.OS ===
  // 'web'` is true in a phone's browser too -- this storefront's main
  // audience arrives from a WhatsApp link on one -- and mobile WebKit/
  // Chrome SYNTHESISE `mouseenter`/`onHoverIn` after a tap ("ghost hover").
  // Before this fix, the old gate (`Platform.OS === 'web'` plus whichever
  // mouse event happened to fire) could not tell that ghost event apart
  // from a real mouse, so the arrows appeared on a touch device -- exactly
  // what the brief rules out. `matchMedia('(hover: hover)')` reporting
  // `false` here stands in for a real touch-only browser; the band and
  // arrows still receive the exact same synthetic hover callbacks a ghost
  // tap would fire, and must not arm regardless.
  it('never arms the hover-revealed arrows on a device that cannot actually hover', async () => {
    matchMedia.mockReturnValue({ matches: false });
    const tree = await render(threeFlyers());

    const band = withTestId(tree, 'storefront-flyer-band')[0];
    await act(async () => { (band.props.onMouseEnter as () => void)(); });
    expect(flatten(withTestId(tree, 'storefront-flyer-prev')[0].props.style).opacity).toBe(0);
    expect(withTestId(tree, 'storefront-flyer-prev')[0].props.pointerEvents).toBe('none');

    // The arrow's OWN `onHoverIn` (armed once the band-level handler has
    // already revealed it, per the arrow's own comment) must not arm it
    // either, on the same device.
    const prevArrow = tree.root.findAll(
      (n) => n.props?.testID === 'storefront-flyer-prev' && typeof n.props?.onHoverIn === 'function',
    )[0];
    await act(async () => { (prevArrow.props.onHoverIn as () => void)(); });
    expect(flatten(withTestId(tree, 'storefront-flyer-prev')[0].props.style).opacity).toBe(0);
    expect(withTestId(tree, 'storefront-flyer-prev')[0].props.pointerEvents).toBe('none');
  });
});
