import { StyleSheet } from 'react-native';
import { act, create } from 'react-test-renderer';

import { AboutGallery, gallerySlideHeightFor } from '@/components/storefront/about-gallery';
import { photoHeightCapFor } from '@/components/storefront/product-sheet';
import { TOUCH_TARGET } from '@/components/storefront/scale';
import { contrastRatio } from '@/lib/contrast';
import { PALETTES, paletteColors } from '@/lib/storefront-catalog';
import type { StorefrontImage } from '@/types/models';

// about-gallery.tsx reaches product-sheet.tsx for `photoHeightCapFor`, which
// pulls in theme-shared.tsx behind ProductActions -- and that constructs the
// real Supabase client at module load, throwing without
// EXPO_PUBLIC_SUPABASE_*. The same unblocking mock every other storefront
// component test carries (storefront-flyer-carousel.test.tsx, among others).
jest.mock('@/lib/supabase', () => ({ supabase: {} }));

const colors = paletteColors('ink');

type HostNode = { type: string; props: Record<string, unknown>; children: unknown[] | null };

// toJSON() yields HOST nodes only, in document order -- the same technique
// storefront-flyer-carousel.test.tsx uses and explains: reading off
// `tree.root` instead double-counts, because Pressable is composite and
// forwards testID down through a forwardRef View to its own host node.
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

function selectedIndex(tree: ReturnType<typeof create>): number {
  return withTestId(tree, 'storefront-about-dot').findIndex((dot) => (
    dot.props['aria-selected'] ?? (dot.props.accessibilityState as { selected?: boolean } | undefined)?.selected
  ) === true);
}

function image(id: string, url = `https://cdn.test/${id}.jpg`): StorefrontImage {
  return { id, url };
}

function render(images: StorefrontImage[], windowHeight = 900) {
  let tree!: ReturnType<typeof create>;
  act(() => {
    tree = create(
      <AboutGallery images={images} colors={colors} windowHeight={windowHeight} onImageError={jest.fn()} />,
    );
  });
  return tree;
}

describe('AboutGallery', () => {
  // Property: zero renders nothing. about-panel.tsx already gates the call
  // site the same way; this is the second line of defence this file's own
  // header comment describes.
  it('renders nothing at all with no photographs', () => {
    const tree = render([]);
    expect(tree.toJSON()).toBeNull();
  });

  // Property: one photo is a hero, not a carousel of one -- flyer-carousel.tsx
  // makes the identical call for `count === 1` and this file follows it.
  it('renders one photo static -- no dots, no arrows, no track', () => {
    const tree = render([image('i1')]);

    expect(withTestId(tree, 'storefront-about-cover')).toHaveLength(1);
    expect(withTestId(tree, 'storefront-about-carousel-track')).toHaveLength(0);
    expect(withTestId(tree, 'storefront-about-dots')).toHaveLength(0);
    expect(withTestId(tree, 'storefront-about-dot')).toHaveLength(0);
    expect(withTestId(tree, 'storefront-about-prev')).toHaveLength(0);
    expect(withTestId(tree, 'storefront-about-next')).toHaveLength(0);
  });

  // Property: two or more is the carousel proper -- swipe, dots, arrows.
  it('renders two or more with one dot per photo and both arrows', () => {
    const tree = render([image('i1'), image('i2'), image('i3')]);

    expect(withTestId(tree, 'storefront-about-carousel-track')).toHaveLength(1);
    expect(withTestId(tree, 'storefront-about-dot')).toHaveLength(3);
    expect(withTestId(tree, 'storefront-about-prev')).toHaveLength(1);
    expect(withTestId(tree, 'storefront-about-next')).toHaveLength(1);
  });

  // The first image is always the cover's own testID, id-based for the rest
  // -- the exact scheme storefront-touch-targets.test.tsx and
  // storefront-shop-tabs.test.tsx both already assert against, carried over
  // unchanged from the cover-plus-thumbnail-strip shape this replaces.
  it('names the first photo the cover and the rest by id', () => {
    const tree = render([image('i1'), image('i2'), image('i3')]);
    expect(withTestId(tree, 'storefront-about-cover')).toHaveLength(1);
    expect(withTestId(tree, 'storefront-about-photo-i2')).toHaveLength(1);
    expect(withTestId(tree, 'storefront-about-photo-i3')).toHaveLength(1);
  });

  // Every photo stays in the tree, in the shop's own order, whether or not it
  // is the one on screen -- the same reason flyer-carousel.tsx keeps every
  // slide mounted (a screen reader and the tab key must reach all of them).
  it('keeps every photo in the tree, in the shop\'s own order', () => {
    const tree = render([image('i1'), image('i2'), image('i3')]);
    const uris = hostNodes(tree)
      .filter((n) => Boolean((n.props?.source as { uri?: string } | undefined)?.uri))
      .map((n) => (n.props.source as { uri: string }).uri);
    expect(uris).toEqual([
      'https://cdn.test/i1.jpg', 'https://cdn.test/i2.jpg', 'https://cdn.test/i3.jpg',
    ]);
  });

  // Property 7's dots half, the identical assertion flyer-carousel.test.tsx
  // makes for its own dots: which slide is showing has to be READABLE, not
  // only visible as a filled circle.
  it('marks the showing dot selected, and moves it when another is pressed', () => {
    const tree = render([image('i1'), image('i2')]);
    expect(selectedIndex(tree)).toBe(0);

    act(() => pressable(tree, 'storefront-about-dot')[1].props.onPress());
    expect(selectedIndex(tree)).toBe(1);
  });

  it('moves forward and back through the arrows, wrapping at either end', () => {
    const tree = render([image('i1'), image('i2'), image('i3')]);

    act(() => pressable(tree, 'storefront-about-next')[0].props.onPress());
    expect(selectedIndex(tree)).toBe(1);

    act(() => pressable(tree, 'storefront-about-prev')[0].props.onPress());
    expect(selectedIndex(tree)).toBe(0);

    // Wraps rather than dead-ending -- an arrow visible but refusing at
    // either end reads as broken, the same argument flyer-carousel.tsx makes
    // for its own arrows.
    act(() => pressable(tree, 'storefront-about-prev')[0].props.onPress());
    expect(selectedIndex(tree)).toBe(2);
  });

  // NOT CONTROLS. A photo here has no action (no category to filter, no
  // WhatsApp chat to open, unlike a flyer) -- confirmed directly, the same
  // ancestor-walk storefront-touch-targets.test.tsx runs against the whole
  // About tab, held here too so a regression fails in the component's own
  // test file and not only the page-level sweep.
  it('wraps no photo in a Pressable -- there is no action for one to take', () => {
    const tree = render([image('i1'), image('i2')]);
    // `tree.root.findAll`, not the `toJSON()` walk `hostNodes` above uses --
    // only the INSTANCE tree carries `.parent`, which an ancestor walk needs.
    // The identical technique storefront-touch-targets.test.tsx already runs
    // against the whole About tab, held here too so a regression fails in
    // this component's own test file first: a Pressable wrapping a photo
    // inserts exactly one node between it and `storefront-about-carousel`,
    // which is what actually fails the day someone adds one.
    const photoNodes = tree.root.findAll((n) => Boolean((n.props?.source as { uri?: string } | undefined)?.uri));
    expect(photoNodes.length).toBeGreaterThan(0);

    for (const photo of photoNodes) {
      let ancestor = photo.parent;
      while (ancestor && ancestor.props?.testID !== 'storefront-about-carousel') {
        expect(typeof ancestor.props?.onPress).not.toBe('function');
        ancestor = ancestor.parent;
      }
    }
  });
});

// THE HEIGHT DECISION (Task 26's other measured complaint), pure and
// unmounted -- nothing in this repo lays out under Jest (react-test-renderer
// never resolves `aspectRatio`), so this is the only honest way to hold the
// exact numbers the brief measured live: 820x360 at 1440 (16:9 of 820 is 461;
// the cap bites, at 900's own 40%) and 326x183 at 390 (16:9 of 326 is 183;
// the cap does not bite, at 844's own 40% of 338). See about-gallery.tsx's
// own header comment on `gallerySlideHeightFor` for why this function is not
// itself called by the render (CSS resolves the same arithmetic there) and
// is verified separately against a real browser (task-26-report.md).
describe('gallerySlideHeightFor', () => {
  it('matches the brief\'s own measurement: 820x360 at 1440x900', () => {
    expect(gallerySlideHeightFor(820, 900)).toBe(360);
  });

  it('matches the brief\'s own measurement: 326x183 at 390x844 -- the cap does not bite', () => {
    expect(gallerySlideHeightFor(326, 844)).toBe(183);
  });

  // The boundary itself: at exactly the width where 16:9 equals the cap,
  // neither branch of the `min` is doing hidden work the other could not.
  it('sits exactly on the natural height at the width where the cap first equals it', () => {
    const windowHeight = 900;
    const cap = photoHeightCapFor(windowHeight); // 360
    const widthAtBoundary = Math.round(cap * (16 / 9)); // 640
    expect(gallerySlideHeightFor(widthAtBoundary, windowHeight)).toBe(cap);
  });

  it('lets the natural 16:9 height through on a narrow phone, where the cap never bites', () => {
    expect(gallerySlideHeightFor(390, 844)).toBe(Math.round(390 * (9 / 16)));
  });

  it('caps a wide slide on a short window, where 16:9 would overrun it', () => {
    // A short, wide window -- the exact shape photoHeightCapFor's own
    // comment (product-sheet.tsx) describes for the 1512x700 laptop.
    expect(gallerySlideHeightFor(820, 500)).toBe(200); // photoHeightCapFor(500) = 200
  });
});

// THE WIRING TEST. A pure function proves the ARITHMETIC; this proves the
// `windowHeight` PROP actually reaches the rendered Image's own `maxHeight`
// -- the "prove it is not vacuous" half nothing lays out under Jest,
// `aspectRatio`, can otherwise stand in for. Two different window heights
// producing two different resolved `maxHeight` values is what tells this
// apart from a hard-coded cap that would render identically either way.
describe('AboutGallery: the height cap is actually wired to windowHeight', () => {
  function coverMaxHeight(tree: ReturnType<typeof create>): number | undefined {
    const cover = tree.root.findAll((n) => n.props?.testID === 'storefront-about-cover')[0];
    const flat = StyleSheet.flatten(cover.props.style as never) as { maxHeight?: number };
    return flat.maxHeight;
  }

  it('caps the single-photo branch at photoHeightCapFor(windowHeight), and moves when the prop does', () => {
    const short = render([image('i1')], 900);
    expect(coverMaxHeight(short)).toBe(photoHeightCapFor(900));
    expect(coverMaxHeight(short)).toBe(360);

    const tall = render([image('i1')], 2000);
    expect(coverMaxHeight(tall)).toBe(photoHeightCapFor(2000));
    expect(coverMaxHeight(tall)).toBe(800);

    // Not the same number -- proof this is actually reading the prop rather
    // than a constant that happens to equal 360 at the more common size.
    expect(coverMaxHeight(short)).not.toBe(coverMaxHeight(tall));
  });

  it('caps every slide of a multi-photo carousel the same way', () => {
    const tree = render([image('i1'), image('i2')], 700);
    const photo = tree.root.findAll((n) => n.props?.testID === 'storefront-about-photo-i2')[0];
    const flat = StyleSheet.flatten(photo.props.style as never) as { maxHeight?: number };
    expect(flat.maxHeight).toBe(photoHeightCapFor(700));
  });
});

// THE DOTS' OWN TAP TARGET -- held directly here too, not only through the
// page-level sweep (storefront-touch-targets.test.tsx), so a regression in
// this component's own shape fails in its own test file first. Copied
// verbatim from flyer-carousel.tsx's fixed shape: the PRESSABLE is
// TOUCH_TARGET square (not `hitSlop` on a 7px dot -- see about-gallery.tsx's
// own comment for why that was the wrong fix on the flyer band).
describe('AboutGallery: the dot is a real 44px box, not a small dot with hitSlop', () => {
  it('gives every dot Pressable a TOUCH_TARGET-square resolved style', () => {
    const tree = render([image('i1'), image('i2')]);
    const dots = tree.root.findAll(
      (n) => n.props?.testID === 'storefront-about-dot' && typeof n.props?.onPress === 'function',
    );
    expect(dots.length).toBe(2);
    for (const dot of dots) {
      const raw = dot.props.style;
      const resolved = typeof raw === 'function' ? raw({ pressed: false }) : raw;
      const flat = StyleSheet.flatten(resolved as never) as { width?: number; height?: number };
      expect(flat.width).toBe(TOUCH_TARGET);
      expect(flat.height).toBe(TOUCH_TARGET);
    }
  });
});

// BOTH DOTS HAVE TO BE VISIBLE, AND ONE OF THEM WAS NOT.
//
// This shipped and was caught in a browser, not here: the unselected dot was
// filled `soft`, copied from flyer-carousel.tsx along with the rest of the dot
// shape. It reads there because those dots sit ON a photo band. These sit on
// the PAGE -- and the page IS `soft`. Measured live on the ink palette, the
// unselected dot was #f4f4f5 on a #f4f4f5 ground: 1.00:1. A shop with two
// photographs rendered exactly one visible dot and no sign there was anywhere
// to go, which is the whole affordance the carousel replaced the thumbnail
// strip with.
//
// Asserted as a RATIO against the surface rather than as a hex, so it is the
// property that is pinned and not today's token: any future fill that happens
// to collapse into the page fails this, including one that is technically a
// different colour. 3:1 is WCAG 1.4.11 for a non-text control, which is the
// bar `edge` is derived to clear (storefront-catalog.ts).
//
// Across ALL SEVEN palettes, because this is exactly the defect that hides in
// one: the selected dot looked right on every palette while the unselected one
// was invisible on the default.
describe('AboutGallery: both dots can actually be seen', () => {
  it.each(PALETTES.map((p) => p.key))('separates selected and unselected dots from the page on %s', (palette) => {
    const paletted = paletteColors(palette);
    let tree!: ReturnType<typeof create>;
    act(() => {
      tree = create(
        <AboutGallery
          images={[image('i1'), image('i2')]}
          colors={paletted}
          windowHeight={900}
          onImageError={jest.fn()}
        />,
      );
    });

    // The 7px mark inside each 44px target, in document order.
    const marks = withTestId(tree, 'storefront-about-dot')
      .map((dot) => (dot.children ?? [])[0] as HostNode)
      .map((mark) => (StyleSheet.flatten(mark.props.style as never) as { backgroundColor?: string }).backgroundColor);

    expect(marks).toHaveLength(2);
    for (const fill of marks) {
      expect(fill).toBeDefined();
      // `soft` is the surface the gallery sits on -- the exact collapse that
      // shipped. Anything at or under 3:1 against it cannot be seen.
      expect(contrastRatio(fill!, paletted.soft)).toBeGreaterThanOrEqual(3);
    }
    // And the two must differ from each other, or a dot row says nothing about
    // WHICH photo is showing even when both are visible.
    expect(marks[0]).not.toBe(marks[1]);
  });
});
