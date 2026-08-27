import { act, create } from 'react-test-renderer';

import { FlyerCarousel } from '@/components/storefront/flyer-carousel';
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
function render(flyers: StorefrontFlyer[], props: Partial<Parameters<typeof FlyerCarousel>[0]> = {}) {
  let tree!: ReturnType<typeof create>;
  act(() => {
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
  it('renders nothing at all when the shop has no flyers', () => {
    const tree = render([]);
    expect(tree.toJSON()).toBeNull();
  });

  // Property 2. A carousel of one with controls nobody can use lies about
  // what is there.
  it('renders one flyer static -- a band, one slide, and no controls', () => {
    const tree = render([flyer()]);

    expect(withTestId(tree, 'storefront-flyer-band')).toHaveLength(1);
    expect(withTestId(tree, 'storefront-flyer-slide')).toHaveLength(1);
    expect(withTestId(tree, 'storefront-flyer-dots')).toHaveLength(0);
    expect(withTestId(tree, 'storefront-flyer-dot')).toHaveLength(0);
    expect(withTestId(tree, 'storefront-flyer-prev')).toHaveLength(0);
    expect(withTestId(tree, 'storefront-flyer-next')).toHaveLength(0);
  });

  // Property 3.
  it('renders two or more with dots and arrows, one dot per flyer', () => {
    const tree = render([flyer({ id: 'f1' }), flyer({ id: 'f2' }), flyer({ id: 'f3' })]);

    expect(withTestId(tree, 'storefront-flyer-slide')).toHaveLength(3);
    expect(withTestId(tree, 'storefront-flyer-dot')).toHaveLength(3);
    expect(withTestId(tree, 'storefront-flyer-prev')).toHaveLength(1);
    expect(withTestId(tree, 'storefront-flyer-next')).toHaveLength(1);
  });

  // Task 4 owns motion, and it owns it because of the rules that come with
  // it: prefers-reduced-motion beating the shop's own setting, stopping for
  // the visit on hover, touch or focus. None of that is written yet, so
  // nothing here may move on its own -- a carousel that advances while
  // somebody is reading is worse than a static image.
  it('never advances on its own -- auto-advance is Task 4', () => {
    jest.useFakeTimers();
    try {
      const tree = render([flyer({ id: 'f1' }), flyer({ id: 'f2' }), flyer({ id: 'f3' })]);
      expect(selectedIndex(tree)).toBe(0);
      act(() => jest.advanceTimersByTime(60_000));
      expect(selectedIndex(tree)).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  // Property 7, the dots half: which slide is showing has to be readable by
  // a screen reader, not only visible as a filled circle.
  it('marks the showing dot selected, and moves it when another is pressed', () => {
    const tree = render([flyer({ id: 'f1' }), flyer({ id: 'f2' })]);
    expect(selectedIndex(tree)).toBe(0);

    act(() => pressable(tree, 'storefront-flyer-dot')[1].props.onPress());
    expect(selectedIndex(tree)).toBe(1);
  });

  it('moves forward and back through the arrows', () => {
    const tree = render([flyer({ id: 'f1' }), flyer({ id: 'f2' }), flyer({ id: 'f3' })]);

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
  it('keeps every slide in the tree, in the shop\'s order', () => {
    const tree = render([
      flyer({ id: 'f1', headline: 'First' }),
      flyer({ id: 'f2', headline: 'Second' }),
      flyer({ id: 'f3', headline: 'Third' }),
    ]);
    const headlines = allText(tree).filter((text) => ['First', 'Second', 'Third'].includes(text));
    expect(headlines).toEqual(['First', 'Second', 'Third']);
  });

  // Property 6/7. 'none' is not interactive -- and must not look it, so no
  // call-to-action either.
  it('gives a link_kind "none" slide no press handler, no role and no call to action', () => {
    const tree = render([flyer({ linkKind: 'none' })]);
    const slide = withTestId(tree, 'storefront-flyer-slide')[0];

    expect(pressable(tree, 'storefront-flyer-slide')).toHaveLength(0);
    expect(slide.props.onClick).toBeUndefined();
    expect(slide.props.accessibilityRole).toBeUndefined();
    expect(slide.props.role).toBeUndefined();
    expect(withTestId(tree, 'storefront-flyer-cta')).toHaveLength(0);
  });

  // Property 6. Filtering is the page's own job, so the slide reports the
  // category rather than reaching into the grid itself.
  it('reports the category a "category" slide names, and labels itself with it', () => {
    const onSelectCategory = jest.fn();
    const tree = render([flyer({ linkKind: 'category', linkValue: 'Solar' })], { onSelectCategory });

    const slide = pressable(tree, 'storefront-flyer-slide')[0];
    expect(slide.props.accessibilityRole).toBe('button');
    expect(slide.props.accessibilityLabel).toBe('See Solar');
    expect(withTestId(tree, 'storefront-flyer-cta')).toHaveLength(1);

    act(() => slide.props.onPress());
    expect(onSelectCategory).toHaveBeenCalledWith('Solar');
  });

  // Property 6. The enquiry is about THIS offer, not a bare "hello".
  it('opens a WhatsApp enquiry naming the flyer', () => {
    const tree = render([flyer({ headline: 'Eid stock has landed', linkKind: 'whatsapp', linkValue: null })]);

    const slide = pressable(tree, 'storefront-flyer-slide')[0];
    expect(slide.props.accessibilityRole).toBe('link');

    act(() => slide.props.onPress());
    expect(openExternalUrl).toHaveBeenCalledWith(
      'https://wa.me/252634456789?text=Hi%20Xamdi%20Electronics%2C%20I%20saw%20%22Eid%20stock%20has%20landed%22%20on%20your%20page.',
    );
  });

  it('sends the owner\'s own message when the flyer carries one', () => {
    const tree = render([flyer({ linkKind: 'whatsapp', linkValue: 'Is the solar lantern still $14?' })]);
    act(() => pressable(tree, 'storefront-flyer-slide')[0].props.onPress());
    expect(openExternalUrl).toHaveBeenCalledWith(
      'https://wa.me/252634456789?text=Is%20the%20solar%20lantern%20still%20%2414%3F',
    );
  });

  // The same rule WhatsAppButton and ProductActions follow: lose the
  // affordance rather than render one that opens a chat with nobody.
  it('makes a WhatsApp slide non-interactive when the shop has no number', () => {
    const tree = render([flyer({ linkKind: 'whatsapp' })], { whatsappE164: null });
    expect(pressable(tree, 'storefront-flyer-slide')).toHaveLength(0);
    expect(withTestId(tree, 'storefront-flyer-cta')).toHaveLength(0);
  });

  // The offer's words are derived by get_public_storefront on every read
  // (20260930000100) and printed here VERBATIM -- the page must not reword
  // what the till will give, and must not reword what the paper poster says
  // either.
  it('prints the derived offer verbatim -- value, scope and window', () => {
    const tree = render([
      flyer({ offer: { value: '20%', scope: 'All Solar', when: 'Friday 14 — Sunday 16 August' } }),
    ]);
    const text = allText(tree);
    expect(text).toContain('20%');
    expect(text).toContain('All Solar');
    expect(text).toContain('Friday 14 — Sunday 16 August');
  });

  it('renders no window line when the offer has no window', () => {
    const tree = render([flyer({ offer: { value: '$2.50', scope: 'Everything in store', when: null } })]);
    expect(withTestId(tree, 'storefront-flyer-offer-when')).toHaveLength(0);
    expect(allText(tree)).toContain('$2.50');
  });
});
