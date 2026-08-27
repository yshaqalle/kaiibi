import { AccessibilityInfo, type EmitterSubscription } from 'react-native';
import { act, create } from 'react-test-renderer';

import { FlyerCarousel, AUTO_ADVANCE_INTERVAL_MS } from '@/components/storefront/flyer-carousel';
import { openExternalUrl } from '@/lib/external-url';
import { paletteColors } from '@/lib/storefront-catalog';
import type { StorefrontFlyer } from '@/types/models';

// flyer-carousel reaches waLink through '@/lib/storefront', which constructs
// the real Supabase client at module load and throws without
// EXPO_PUBLIC_SUPABASE_* -- same unblocking mock every other storefront
// component test carries. '@/lib/external-url' is the DOM/tab boundary: the
// WhatsApp slide is asserted by what URL it would have opened.
jest.mock('@/lib/supabase', () => ({ supabase: {} }));
jest.mock('@/lib/external-url', () => ({ openExternalUrl: jest.fn() }));

const colors = paletteColors('ink');

// The device's reduced-motion preference, as FlyerCarousel reads it --
// AccessibilityInfo.isReduceMotionEnabled() on mount, plus a
// 'reduceMotionChanged' subscription for a live change. Spied rather than
// jest.mock('react-native', ...) so View/ScrollView/Pressable stay real and
// only this one API is under test control. Reset every test rather than
// re-spied, so a spy from an earlier test cannot leak its queued
// mockResolvedValueOnce into the next one.
const isReduceMotionEnabled = jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled');
const addAccessibilityListener = jest.spyOn(AccessibilityInfo, 'addEventListener');
let reduceMotionHandler: ((value: boolean) => void) | null = null;

beforeEach(() => {
  reduceMotionHandler = null;
  isReduceMotionEnabled.mockReset().mockResolvedValue(false);
  addAccessibilityListener.mockReset().mockImplementation(((event: string, handler: (value: boolean) => void) => {
    if (event === 'reduceMotionChanged') reduceMotionHandler = handler;
    return { remove: jest.fn() } as unknown as EmitterSubscription;
  }) as typeof AccessibilityInfo.addEventListener);
});

type HostNode = { type: string; props: Record<string, unknown>; children: unknown[] | null };

// toJSON() yields HOST nodes only, in document order -- which is what both
// "how many dots are there" and "is the band above the goods" need. Reading
// them off `tree.root` instead double-counts: Pressable is composite and
// forwards testID down through a forwardRef View to its own host node, so
// every button matches twice.
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

// The composite instance carrying onPress -- filtering on the handler gives
// one match per button rather than the composite/host pair.
function pressable(tree: ReturnType<typeof create>, testID: string) {
  return tree.root.findAll((node) => node.props?.testID === testID && typeof node.props?.onPress === 'function');
}

function allText(tree: ReturnType<typeof create>): string[] {
  const out: string[] = [];
  const walk = (node: unknown) => {
    if (node == null) return;
    if (typeof node === 'string') {
      out.push(node);
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    ((node as HostNode).children ?? []).forEach(walk);
  };
  walk(tree.toJSON() as unknown);
  return out;
}

// Which slide the band says is showing. Read off the dots' own
// accessibilityState rather than a style, because "selected" being READABLE
// is the property under test as much as which one it is.
function selectedIndex(tree: ReturnType<typeof create>): number {
  return withTestId(tree, 'storefront-flyer-dot').findIndex((dot) => (
    dot.props['aria-selected'] ?? (dot.props.accessibilityState as { selected?: boolean } | undefined)?.selected
  ) === true);
}

function flyer(over: Partial<StorefrontFlyer> = {}): StorefrontFlyer {
  return {
    id: 'f1',
    imageUrl: 'https://cdn.example/shop/eid.jpg',
    headline: 'Eid stock has landed',
    subline: 'New lanterns, kettles and cables in store now.',
    linkKind: 'none',
    linkValue: null,
    offer: null,
    ...over,
  };
}

// create() alone renders nothing here: the root is concurrent, so the first
// commit is scheduled rather than synchronous and toJSON() is still null when
// the call returns. act() flushes it -- the same wrapper every other
// storefront component test uses, for the same reason.
//
// ASYNC, and awaiting an async act(), since Task 4: the mount effect calls
// AccessibilityInfo.isReduceMotionEnabled(), which resolves on a microtask.
// A sync act() returns before that microtask runs, so a caller that read
// motion state immediately after render() would see the state from BEFORE
// the (mocked) device ever answered -- flaky by construction. Fake timers
// (used by the motion tests below) do not fake the microtask queue, so this
// await still settles even inside a jest.useFakeTimers() block.
async function render(flyers: StorefrontFlyer[], props: Partial<Parameters<typeof FlyerCarousel>[0]> = {}) {
  let tree!: ReturnType<typeof create>;
  await act(async () => {
    tree = create(
      <FlyerCarousel
        flyers={flyers}
        colors={colors}
        shopName="Xamdi Electronics"
        whatsappE164="+252634456789"
        {...props}
      />,
    );
  });
  return tree;
}

describe('FlyerCarousel', () => {
  beforeEach(() => (openExternalUrl as jest.Mock).mockReset());

  // Property 1. The photo-optional rule every theme already follows: no empty
  // frame, no "add a flyer" placeholder facing a customer.
  it('renders nothing at all when the shop has no flyers', async () => {
    const tree = await render([]);
    expect(tree.toJSON()).toBeNull();
  });

  // Property 2. A carousel of one with controls nobody can use lies about
  // what is there.
  it('renders one flyer static -- a band, one slide, and no controls', async () => {
    const tree = await render([flyer()]);

    expect(withTestId(tree, 'storefront-flyer-band')).toHaveLength(1);
    expect(withTestId(tree, 'storefront-flyer-slide')).toHaveLength(1);
    expect(withTestId(tree, 'storefront-flyer-dots')).toHaveLength(0);
    expect(withTestId(tree, 'storefront-flyer-dot')).toHaveLength(0);
    expect(withTestId(tree, 'storefront-flyer-prev')).toHaveLength(0);
    expect(withTestId(tree, 'storefront-flyer-next')).toHaveLength(0);
  });

  // Property 3.
  it('renders two or more with dots and arrows, one dot per flyer', async () => {
    const tree = await render([flyer({ id: 'f1' }), flyer({ id: 'f2' }), flyer({ id: 'f3' })]);

    expect(withTestId(tree, 'storefront-flyer-slide')).toHaveLength(3);
    expect(withTestId(tree, 'storefront-flyer-dot')).toHaveLength(3);
    expect(withTestId(tree, 'storefront-flyer-prev')).toHaveLength(1);
    expect(withTestId(tree, 'storefront-flyer-next')).toHaveLength(1);
  });

  // Default off (property 1): a shop that has never touched auto_advance
  // must not move. Paired with the 'Task 4: motion' describe block below,
  // which proves the opposite case -- that a timer really does exist and
  // really does move the band once the shop turns it on. Without that pair,
  // this test alone cannot tell "correctly did not advance" from "the timer
  // never existed" -- see storefront-flyer-carousel.test.tsx's own mutation
  // notes in task-4-report.md.
  it('never advances on its own when the shop has not turned auto-advance on', async () => {
    jest.useFakeTimers();
    try {
      const tree = await render([flyer({ id: 'f1' }), flyer({ id: 'f2' }), flyer({ id: 'f3' })]);
      expect(selectedIndex(tree)).toBe(0);
      act(() => jest.advanceTimersByTime(60_000));
      expect(selectedIndex(tree)).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  // Property 7, the dots half: which slide is showing has to be readable by
  // a screen reader, not only visible as a filled circle.
  it('marks the showing dot selected, and moves it when another is pressed', async () => {
    const tree = await render([flyer({ id: 'f1' }), flyer({ id: 'f2' })]);
    expect(selectedIndex(tree)).toBe(0);

    act(() => pressable(tree, 'storefront-flyer-dot')[1].props.onPress());
    expect(selectedIndex(tree)).toBe(1);
  });

  it('moves forward and back through the arrows', async () => {
    const tree = await render([flyer({ id: 'f1' }), flyer({ id: 'f2' }), flyer({ id: 'f3' })]);

    act(() => pressable(tree, 'storefront-flyer-next')[0].props.onPress());
    expect(selectedIndex(tree)).toBe(1);

    act(() => pressable(tree, 'storefront-flyer-prev')[0].props.onPress());
    expect(selectedIndex(tree)).toBe(0);

    // Wraps rather than dead-ends: an arrow a customer can see and cannot
    // use is the same lie a dot on a single flyer would be.
    act(() => pressable(tree, 'storefront-flyer-prev')[0].props.onPress());
    expect(selectedIndex(tree)).toBe(2);
  });

  // Property 7, the slides half. Every flyer is in the tree in the shop's own
  // order whether or not it is the one on screen, so the tab key and a screen
  // reader walk all of them rather than reaching only the visible one.
  it('keeps every slide in the tree, in the shop\'s order', async () => {
    const tree = await render([
      flyer({ id: 'f1', headline: 'First' }),
      flyer({ id: 'f2', headline: 'Second' }),
      flyer({ id: 'f3', headline: 'Third' }),
    ]);
    const headlines = allText(tree).filter((text) => ['First', 'Second', 'Third'].includes(text));
    expect(headlines).toEqual(['First', 'Second', 'Third']);
  });

  // Property 6/7. 'none' is not interactive -- and must not look it, so no
  // call-to-action either.
  it('gives a link_kind "none" slide no press handler, no role and no call to action', async () => {
    const tree = await render([flyer({ linkKind: 'none' })]);
    const slide = withTestId(tree, 'storefront-flyer-slide')[0];

    expect(pressable(tree, 'storefront-flyer-slide')).toHaveLength(0);
    expect(slide.props.onClick).toBeUndefined();
    expect(slide.props.accessibilityRole).toBeUndefined();
    expect(slide.props.role).toBeUndefined();
    expect(withTestId(tree, 'storefront-flyer-cta')).toHaveLength(0);
  });

  // Property 6. Filtering is the page's own job, so the slide reports the
  // category rather than reaching into the grid itself.
  it('reports the category a "category" slide names, and labels itself with it', async () => {
    const onSelectCategory = jest.fn();
    const tree = await render([flyer({ linkKind: 'category', linkValue: 'Solar' })], { onSelectCategory });

    const slide = pressable(tree, 'storefront-flyer-slide')[0];
    expect(slide.props.accessibilityRole).toBe('button');
    expect(slide.props.accessibilityLabel).toBe('See Solar');
    expect(withTestId(tree, 'storefront-flyer-cta')).toHaveLength(1);

    act(() => slide.props.onPress());
    expect(onSelectCategory).toHaveBeenCalledWith('Solar');
  });

  // Property 6. The enquiry is about THIS offer, not a bare "hello".
  it('opens a WhatsApp enquiry naming the flyer', async () => {
    const tree = await render([flyer({ headline: 'Eid stock has landed', linkKind: 'whatsapp', linkValue: null })]);

    const slide = pressable(tree, 'storefront-flyer-slide')[0];
    expect(slide.props.accessibilityRole).toBe('link');

    act(() => slide.props.onPress());
    expect(openExternalUrl).toHaveBeenCalledWith(
      'https://wa.me/252634456789?text=Hi%20Xamdi%20Electronics%2C%20I%20saw%20%22Eid%20stock%20has%20landed%22%20on%20your%20page.',
    );
  });

  it('sends the owner\'s own message when the flyer carries one', async () => {
    const tree = await render([flyer({ linkKind: 'whatsapp', linkValue: 'Is the solar lantern still $14?' })]);
    act(() => pressable(tree, 'storefront-flyer-slide')[0].props.onPress());
    expect(openExternalUrl).toHaveBeenCalledWith(
      'https://wa.me/252634456789?text=Is%20the%20solar%20lantern%20still%20%2414%3F',
    );
  });

  // The same rule WhatsAppButton and ProductActions follow: lose the
  // affordance rather than render one that opens a chat with nobody.
  it('makes a WhatsApp slide non-interactive when the shop has no number', async () => {
    const tree = await render([flyer({ linkKind: 'whatsapp' })], { whatsappE164: null });
    expect(pressable(tree, 'storefront-flyer-slide')).toHaveLength(0);
    expect(withTestId(tree, 'storefront-flyer-cta')).toHaveLength(0);
  });

  // The offer arrives from get_public_storefront as the promotion's RAW FACTS
  // (20260930000300) and is worded HERE, by offerCopyFor -- the very function
  // the printed poster comes through (src/lib/poster.ts). These assert the
  // rendered strings rather than "offerCopyFor was called", because what must
  // not drift is the WORDS: the page must not reword what the till will give,
  // and must not reword what the paper poster says either.
  //
  // The equivalent expectations for the poster live in poster.test.ts and are
  // deliberately not repeated as a second copy -- one function, one set of
  // cases, which is the point of the change.
  it('words the offer from the promotion facts -- value, scope and window', async () => {
    const tree = await render([
      flyer({
        offer: {
          discountType: 'percentage', discountValue: 20,
          scope: 'category', scopeValue: 'Solar',
          startsAt: new Date(2026, 7, 14).toISOString(),
          endsAt: new Date(2026, 7, 17).toISOString(),
        },
      }),
    ]);
    const text = allText(tree);
    expect(text).toContain('20%');
    expect(text).toContain('All Solar');
    // Stored exclusive, printed inclusive -- the 17th stored is the 16th read.
    expect(text).toContain('Friday 14 — Sunday 16 August');
  });

  // The money branch, through formatCents -- the same formatter the till and
  // the receipt use, never a hand-rolled '$'.
  it('renders no window line when the offer has no window, and prints money as money', async () => {
    const tree = await render([flyer({
      offer: {
        discountType: 'fixed', discountValue: 250,
        scope: 'store', scopeValue: null, startsAt: null, endsAt: null,
      },
    })]);
    expect(withTestId(tree, 'storefront-flyer-offer-when')).toHaveLength(0);
    expect(allText(tree)).toContain('$2.50');
    expect(allText(tree)).toContain('Everything in store');
  });

  // The WhatsApp enquiry names the offer when the flyer has no headline, and
  // it has to name it in the SAME words the panel shows -- both come through
  // offerCopyFor, so there is nowhere for a second phrasing to appear.
  it('names the worded offer in a WhatsApp enquiry when there is no headline', async () => {
    const tree = await render([flyer({
      headline: null, linkKind: 'whatsapp', linkValue: null,
      offer: {
        discountType: 'percentage', discountValue: 20,
        scope: 'brand', scopeValue: 'Somtel', startsAt: null, endsAt: null,
      },
    })]);
    act(() => pressable(tree, 'storefront-flyer-slide')[0].props.onPress());
    expect(openExternalUrl).toHaveBeenCalledWith(
      'https://wa.me/252634456789?text=Hi%20Xamdi%20Electronics%2C%20I%20saw%20%2220%25%20off%20anything%20by%20somtel%22%20on%20your%20page.',
    );
  });
});

// Task 4: motion. Auto-advance the band, but only when the SHOP has asked
// for it (auto_advance) AND the CUSTOMER's device has not asked for the
// opposite (prefers-reduced-motion) -- and even then, stop for good the
// moment the customer hovers, touches or focuses the band, because a
// carousel that moves while somebody is reading is worse than a static
// image.
//
// The three flyers below all take a full three-item cycle to prove a wrap
// (0 -> 1 -> 2 -> 0), the same reason the manual-arrow test above uses three
// rather than two.
describe('FlyerCarousel: motion', () => {
  beforeEach(() => (openExternalUrl as jest.Mock).mockReset());

  const threeFlyers = () => [flyer({ id: 'f1' }), flyer({ id: 'f2' }), flyer({ id: 'f3' })];

  // How many fake timers a mount adds, isolated from React's own Scheduler
  // package -- which polyfills its work loop with a `setTimeout` when
  // MessageChannel is unavailable (as under this test environment) and
  // therefore leaves ONE pending timer of its own for every mount, whether
  // or not FlyerCarousel schedules anything. Measured as a DELTA around the
  // mount rather than asserted as an absolute `getTimerCount()`, so this
  // stays a real proof that our interval specifically was or was not
  // created, not a hard-coded guess at an internal that a future React or
  // Jest upgrade could change.
  async function timersAddedBy(mount: () => Promise<unknown>): Promise<number> {
    const before = jest.getTimerCount();
    await mount();
    return jest.getTimerCount() - before;
  }

  // The positive control every "never advances" assertion in this file
  // needs. Without this test passing, none of the others can tell "correctly
  // blocked" from "the timer was never built" -- and every one of them was
  // run with this exact mutation (see task-4-report.md's mutation table).
  it('advances through the slides on an interval once the shop turns it on and the device does not ask for less motion', async () => {
    jest.useFakeTimers();
    try {
      const tree = await render(threeFlyers(), { autoAdvance: true });
      expect(selectedIndex(tree)).toBe(0);

      await act(async () => { jest.advanceTimersByTime(AUTO_ADVANCE_INTERVAL_MS); });
      expect(selectedIndex(tree)).toBe(1);

      await act(async () => { jest.advanceTimersByTime(AUTO_ADVANCE_INTERVAL_MS); });
      expect(selectedIndex(tree)).toBe(2);

      // Wraps, same as the arrows -- a customer must never see it dead-end.
      await act(async () => { jest.advanceTimersByTime(AUTO_ADVANCE_INTERVAL_MS); });
      expect(selectedIndex(tree)).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  // Property 2, the primary case named in the brief: reduced motion beats
  // auto_advance = true. `timersAddedBy` (not just the index) is asserted so
  // this fails even against an implementation that starts a timer and then
  // merely never lets it move the index -- that would still be a live timer
  // ticking on a customer's phone for no reason. 1 is React's own Scheduler
  // timer (see timersAddedBy's comment); a second would be ours.
  it('does not advance when the device asks for reduced motion, even though the shop turned auto-advance on', async () => {
    isReduceMotionEnabled.mockResolvedValue(true);
    jest.useFakeTimers();
    try {
      let tree!: Awaited<ReturnType<typeof render>>;
      expect(await timersAddedBy(async () => { tree = await render(threeFlyers(), { autoAdvance: true }); })).toBe(1);
      expect(selectedIndex(tree)).toBe(0);

      await act(async () => { jest.advanceTimersByTime(AUTO_ADVANCE_INTERVAL_MS * 3); });
      expect(selectedIndex(tree)).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  // Property 2, the other direction named in the brief: the device is FINE
  // with motion (reduced motion false), but the shop never turned
  // auto_advance on. Off stays off -- reduced-motion=false is not itself a
  // request for movement.
  it('does not advance when auto-advance is off, even though the device does not ask for reduced motion', async () => {
    isReduceMotionEnabled.mockResolvedValue(false);
    jest.useFakeTimers();
    try {
      let tree!: Awaited<ReturnType<typeof render>>;
      expect(await timersAddedBy(async () => { tree = await render(threeFlyers(), { autoAdvance: false }); })).toBe(1);
      await act(async () => { jest.advanceTimersByTime(AUTO_ADVANCE_INTERVAL_MS * 3); });
      expect(selectedIndex(tree)).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  // A live change while the band is already moving -- not only the value
  // AccessibilityInfo.isReduceMotionEnabled() answers at mount. Drives the
  // 'reduceMotionChanged' subscription property 8 requires a test be able to
  // fire, in both directions: starts moving, an OS-level toggle switches
  // reduced motion on mid-visit, and it stops -- not merely stalls one tick
  // late.
  it('stops immediately when reduced motion turns on mid-visit, via the reduceMotionChanged event', async () => {
    jest.useFakeTimers();
    try {
      const tree = await render(threeFlyers(), { autoAdvance: true });
      await act(async () => { jest.advanceTimersByTime(AUTO_ADVANCE_INTERVAL_MS); });
      expect(selectedIndex(tree)).toBe(1);

      expect(reduceMotionHandler).not.toBeNull();
      act(() => reduceMotionHandler?.(true));

      await act(async () => { jest.advanceTimersByTime(AUTO_ADVANCE_INTERVAL_MS * 3); });
      expect(selectedIndex(tree)).toBe(1);
    } finally {
      jest.useRealTimers();
    }
  });

  // Property 5. Nowhere to go, whatever the setting says -- and this has to
  // be proved by the ABSENCE of a scheduled timer, not only by the absence
  // of dots (a single flyer has none to read an index off).
  it('never advances a single flyer, whatever the setting says', async () => {
    jest.useFakeTimers();
    try {
      let tree!: Awaited<ReturnType<typeof render>>;
      expect(await timersAddedBy(async () => { tree = await render([flyer()], { autoAdvance: true }); })).toBe(1);
      await act(async () => { jest.advanceTimersByTime(AUTO_ADVANCE_INTERVAL_MS * 5); });
      expect(withTestId(tree, 'storefront-flyer-slide')).toHaveLength(1);
    } finally {
      jest.useRealTimers();
    }
  });

  // Property 3. Hover stops it, and it does not resume for the visit -- the
  // second assertion is the one that separates "paused" from "stopped for
  // good": time keeps passing well past several more intervals and the band
  // never moves again.
  it('stops on hover and never resumes for the visit', async () => {
    jest.useFakeTimers();
    try {
      const tree = await render(threeFlyers(), { autoAdvance: true });
      await act(async () => { jest.advanceTimersByTime(AUTO_ADVANCE_INTERVAL_MS); });
      expect(selectedIndex(tree)).toBe(1);

      const band = withTestId(tree, 'storefront-flyer-band')[0];
      act(() => (band.props.onMouseEnter as (() => void) | undefined)?.());

      await act(async () => { jest.advanceTimersByTime(AUTO_ADVANCE_INTERVAL_MS * 5); });
      expect(selectedIndex(tree)).toBe(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('stops on touch and never resumes for the visit', async () => {
    jest.useFakeTimers();
    try {
      const tree = await render(threeFlyers(), { autoAdvance: true });
      await act(async () => { jest.advanceTimersByTime(AUTO_ADVANCE_INTERVAL_MS); });
      expect(selectedIndex(tree)).toBe(1);

      const band = withTestId(tree, 'storefront-flyer-band')[0];
      act(() => (band.props.onTouchStart as (() => void) | undefined)?.());

      await act(async () => { jest.advanceTimersByTime(AUTO_ADVANCE_INTERVAL_MS * 5); });
      expect(selectedIndex(tree)).toBe(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('stops on keyboard focus and never resumes for the visit', async () => {
    jest.useFakeTimers();
    try {
      const tree = await render(threeFlyers(), { autoAdvance: true });
      await act(async () => { jest.advanceTimersByTime(AUTO_ADVANCE_INTERVAL_MS); });
      expect(selectedIndex(tree)).toBe(1);

      const band = withTestId(tree, 'storefront-flyer-band')[0];
      act(() => (band.props.onFocus as (() => void) | undefined)?.());

      await act(async () => { jest.advanceTimersByTime(AUTO_ADVANCE_INTERVAL_MS * 5); });
      expect(selectedIndex(tree)).toBe(1);
    } finally {
      jest.useRealTimers();
    }
  });

  // Property 4. A stopped-for-the-visit band is not a broken one: the dots,
  // arrows and swipe stay real controls throughout, before the stop and
  // after it.
  it('keeps the dots and arrows working after auto-advance has stopped for the visit', async () => {
    jest.useFakeTimers();
    try {
      const tree = await render(threeFlyers(), { autoAdvance: true });
      const band = withTestId(tree, 'storefront-flyer-band')[0];
      act(() => (band.props.onTouchStart as (() => void) | undefined)?.());

      act(() => pressable(tree, 'storefront-flyer-next')[0].props.onPress());
      expect(selectedIndex(tree)).toBe(1);

      act(() => pressable(tree, 'storefront-flyer-dot')[2].props.onPress());
      expect(selectedIndex(tree)).toBe(2);
    } finally {
      jest.useRealTimers();
    }
  });
});
