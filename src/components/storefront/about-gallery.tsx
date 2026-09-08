import { useEffect, useRef, useState } from 'react';
import {
  Image, Platform, Pressable, ScrollView, StyleSheet, Text, View,
  type LayoutChangeEvent, type NativeScrollEvent, type NativeSyntheticEvent,
} from 'react-native';

import {
  clampOffset, nearestIndex, nextWheelOffset, shouldConsumeWheel, supportsHover, wheelPanDelta,
} from '@/components/storefront/mouse-pan';
import { pressable } from '@/components/storefront/press-feedback';
import { photoHeightCapFor } from '@/components/storefront/product-sheet';
import { RADIUS, TOUCH_TARGET } from '@/components/storefront/scale';
import type { PaletteColors } from '@/lib/storefront-catalog';
import type { StorefrontImage } from '@/types/models';

// TASK 26: THE ABOUT GALLERY BECOMES A CAROUSEL.
//
// The shop-photo row this replaces put a full-width 16:9 cover above a
// thumbnail strip -- and both halves of that shape were measured broken.
// Live at 1440x900: the cover alone drew 1376x774 (86% of the viewport), and
// a shop with exactly two photos (the common case, seeded live on
// `yusefshop`) put its second photo in a 168x76 box stranded in a 1376px-wide
// row -- "the picture takes the entire page" and "there is another picture"
// are the same customer looking at those two numbers. See task-26-brief.md.
//
// The fix is the SAME PATTERN flyer-carousel.tsx already carries for the
// poster band above the goods: one photo on screen at a time, with dots, at
// a bounded height -- rather than a second, independently-invented carousel.
// `mouse-pan.ts`'s six pure helpers (wheelPanDelta, clampOffset,
// nextWheelOffset, shouldConsumeWheel, nearestIndex, supportsHover) were
// extracted from that file in Task 15 *for exactly this moment* -- a second
// carousel that needs the identical wheel/drag/hover arithmetic without
// carrying a second copy of it. What is NOT shared, deliberately (see
// mouse-pan.ts's own header comment): the EFFECTFUL wiring -- the wheel
// listener, the pointer-capture drag, the hover-arm state -- because "one
// photo per slide, no per-slide action" and "a poster that can open a
// WhatsApp chat or filter the grid" are different enough policies that a
// shared component would need as many branches as the two carousels already
// differ by. This file is a trimmed sibling of flyer-carousel.tsx: same
// paging/wheel/drag/dot mechanics, none of flyer-carousel's own headline,
// offer, call-to-action, per-slide action or auto-advance -- a shop photo has
// none of those, and building branches for them here would be dead code
// nothing could ever reach.
//
// THREE SHAPES, the same rule every optional block on this page follows
// (about-panel.tsx's own header comment, ProductTile's photo-optional rule,
// ThemeWindow's hero_image_url):
//
//   ZERO renders NOTHING. about-panel.tsx already gates this file's whole
//   call site on `shownImages.length > 0`; the guard below is only a second
//   line of defence for a caller that renders this file directly (this
//   file's own tests do, to prove the rule holds even without that gate).
//
//   ONE renders STATIC -- no dots, no arrows, no ScrollView at all. A single
//   dot a customer can press to arrive where they already stand is a lie
//   about there being somewhere to go; flyer-carousel.tsx makes this exact
//   call for `count === 1` and this file follows it.
//
//   TWO OR MORE renders the carousel: swipe (a paging ScrollView), dots and,
//   on a hover-capable pointer, arrows.
//
// THE HEIGHT (Task 26's other measured complaint). `photoHeightCapFor`
// (product-sheet.tsx) already carries the reasoning for 40% of the window's
// own height -- imported here rather than a second `* 0.4` written by hand,
// per the brief's own instruction. Applied the SAME WAY product-sheet.tsx
// applies it to its own photo: `aspectRatio` plus a `maxHeight` computed from
// the window, not a JS-measured width fed back into a style. That is what
// lets the height resolve correctly on the very first frame, before this
// component's own `onLayout` has ever fired -- CSS resolves
// `min(aspectRatio-derived height, maxHeight)` for us; nothing here needs to
// measure a slide's rendered width to cap its height. `gallerySlideHeightFor`
// below states that same arithmetic as a plain function ANYWAY, because
// nothing in this repo lays out under Jest (react-test-renderer never
// resolves `aspectRatio`) -- so it is the only honest way to hold the numbers
// the brief measured (820x360 at 1440, 326x183 at 390) in a test at all. It
// is not called by the render below; it is the documented, tested statement
// of what that render's CSS is asked to do, verified separately against a
// real browser (see task-26-report.md).
export function gallerySlideHeightFor(slideWidth: number, windowHeight: number): number {
  const natural = Math.round(slideWidth * (9 / 16));
  return Math.min(natural, photoHeightCapFor(windowHeight));
}

type Props = {
  images: StorefrontImage[];
  colors: PaletteColors;
  // Threaded down from the theme file that already calls
  // `useWindowDimensions()` to compute `wide` (theme-market.tsx,
  // theme-window.tsx, theme-counter.tsx all destructure `height` off that
  // same call now) -- see about-panel.tsx's own comment on why this file
  // does not call the hook itself. Passing a number down the same path
  // `wide` already travels costs no new subscription: the theme already
  // re-renders on any window-dimension change, `wide` or not.
  windowHeight: number;
  // Per-image, by id, so a photo that fails to load can be dropped from the
  // NEXT render without the gallery losing its place among the ones that
  // didn't -- about-panel.tsx's own `dropImage`/`failed` state owns this;
  // this file only ever reports which id broke.
  onImageError: (id: string) => void;
};

export function AboutGallery({ images, colors, windowHeight, onImageError }: Props) {
  // Seeded at 0, not at a window width the way flyer-carousel seeds this same
  // state -- that seed exists there to avoid a visible collapse while
  // `styles.band` (this file's own `band` below carries the identical
  // anti-runaway `width: '100%'` fix) is unmeasured. Reading the window here
  // too, only to guess this number a little sooner, would be the second
  // subscription this file's own header comment says `windowHeight` was
  // threaded down specifically to avoid. `onLayout` below corrects this to
  // the band's real width before a customer's swipe or a laptop's wheel ever
  // needs it to be exact; the one frame it takes is the same cost any
  // onLayout-measured width in this codebase already pays.
  const [width, setWidth] = useState(0);
  const [index, setIndex] = useState(0);
  const scroller = useRef<ScrollView>(null);

  const count = images.length;
  const photoHeightCap = photoHeightCapFor(windowHeight);

  // WEB MOUSE -- the identical shape flyer-carousel.tsx carries for the
  // poster band, unchanged in mechanics (see this file's own header comment
  // for why the shared arithmetic is imported rather than re-derived and the
  // effectful wiring is a second copy rather than a shared one).
  const offsetXRef = useRef(0);
  const [mousePanning, setMousePanning] = useState(false);
  const dragRef = useRef<{ startX: number; startOffset: number } | null>(null);
  const wheelSettleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [armHover, setArmHover] = useState(false);
  const [hoverCapable] = useState(supportsHover);

  function armHoverOn() {
    if (hoverCapable) setArmHover(true);
  }

  useEffect(() => () => {
    if (wheelSettleTimer.current) clearTimeout(wheelSettleTimer.current);
  }, []);

  function goTo(next: number) {
    if (count < 2) return;
    // Wraps, the same reason flyer-carousel's arrows wrap: an arrow visible
    // but refusing at either end reads as broken, not as "there is no more".
    const target = ((next % count) + count) % count;
    setIndex(target);
    scroller.current?.scrollTo({ x: target * width, animated: true });
  }

  function handleMomentumEnd(event: NativeSyntheticEvent<NativeScrollEvent>) {
    const offset = event.nativeEvent.contentOffset.x;
    if (width <= 0) return;
    setIndex(nearestIndex(offset, width, count));
  }

  function handleLayout(event: LayoutChangeEvent) {
    const measured = event.nativeEvent.layout.width;
    if (measured > 0 && measured !== width) setWidth(measured);
  }

  function handleScrollSync(event: NativeSyntheticEvent<NativeScrollEvent>) {
    offsetXRef.current = event.nativeEvent.contentOffset.x;
  }

  function handleWheel(event: { deltaX: number; deltaY: number; preventDefault: () => void }) {
    if (width <= 0) return;
    const maxOffset = Math.max(0, (count - 1) * width);
    const delta = wheelPanDelta(event.deltaX, event.deltaY);
    if (!shouldConsumeWheel(offsetXRef.current, maxOffset, delta)) return;
    event.preventDefault();
    setMousePanning(true);
    const next = nextWheelOffset(offsetXRef.current, event.deltaX, event.deltaY, maxOffset);
    offsetXRef.current = next;
    scroller.current?.scrollTo({ x: next, animated: false });
    if (wheelSettleTimer.current) clearTimeout(wheelSettleTimer.current);
    wheelSettleTimer.current = setTimeout(() => {
      setMousePanning(false);
      goTo(nearestIndex(offsetXRef.current, width, count));
    }, 140);
  }

  // Same `handleWheelRef` indirection flyer-carousel.tsx uses and explains at
  // length: the listener is attached to the DOM node once, non-passively,
  // and must still call the LATEST closure (current `width`/`count`) rather
  // than the one captured when it was first attached.
  const handleWheelRef = useRef(handleWheel);
  useEffect(() => {
    handleWheelRef.current = handleWheel;
  });

  useEffect(() => {
    if (Platform.OS !== 'web') return undefined;
    const node = scroller.current as unknown as {
      addEventListener?: (type: 'wheel', cb: (event: WheelEvent) => void, options?: AddEventListenerOptions) => void;
      removeEventListener?: (type: 'wheel', cb: (event: WheelEvent) => void, options?: AddEventListenerOptions) => void;
    } | null;
    if (!node?.addEventListener) return undefined;
    const listener = (event: WheelEvent) => handleWheelRef.current(event);
    node.addEventListener('wheel', listener, { passive: false });
    return () => node.removeEventListener?.('wheel', listener, { passive: false });
  }, [count]);

  function handlePointerDown(event: {
    pointerType: string; pointerId: number; clientX: number;
    currentTarget?: { setPointerCapture?: (id: number) => void };
  }) {
    if (event.pointerType !== 'mouse') return;
    event.currentTarget?.setPointerCapture?.(event.pointerId);
    dragRef.current = { startX: event.clientX, startOffset: offsetXRef.current };
    setMousePanning(true);
  }

  function handlePointerMove(event: { clientX: number }) {
    const drag = dragRef.current;
    if (!drag || width <= 0) return;
    const dx = event.clientX - drag.startX;
    const maxOffset = Math.max(0, (count - 1) * width);
    const next = clampOffset(drag.startOffset - dx, maxOffset);
    offsetXRef.current = next;
    scroller.current?.scrollTo({ x: next, animated: false });
  }

  function handlePointerUp() {
    if (!dragRef.current) return;
    dragRef.current = null;
    setMousePanning(false);
    if (width > 0) goTo(nearestIndex(offsetXRef.current, width, count));
  }

  // Property: zero renders nothing. about-panel.tsx already gates this call
  // site the same way (`shownImages.length > 0`); kept here too so this
  // component's own contract does not depend on a caller remembering that.
  if (count === 0) return null;

  // Property: one photo is a hero, not a carousel of one.
  if (count === 1) {
    return (
      <View style={styles.gallery} testID="storefront-about-carousel">
        <Image
          testID="storefront-about-cover"
          source={{ uri: images[0].url! }}
          onError={() => onImageError(images[0].id)}
          style={[styles.photo, { backgroundColor: colors.soft, maxHeight: photoHeightCap }]}
          resizeMode="cover"
        />
      </View>
    );
  }

  return (
    <View
      style={styles.gallery}
      testID="storefront-about-carousel"
      onLayout={handleLayout}
      {...{ onMouseEnter: armHoverOn, onMouseLeave: () => setArmHover(false) }}
    >
      <ScrollView
        ref={scroller}
        testID="storefront-about-carousel-track"
        horizontal
        pagingEnabled={!mousePanning}
        showsHorizontalScrollIndicator={false}
        onMomentumScrollEnd={handleMomentumEnd}
        onScroll={Platform.OS === 'web' ? handleScrollSync : undefined}
        scrollEventThrottle={Platform.OS === 'web' ? 16 : undefined}
        {...(Platform.OS === 'web' ? ({
          onPointerDown: handlePointerDown,
          onPointerMove: handlePointerMove,
          onPointerUp: handlePointerUp,
          onPointerCancel: handlePointerUp,
        } as any) : {})}
      >
        {/* Every photo stays in the tree, in the shop's own order, whether or
            not it is the one on screen -- the same reason flyer-carousel.tsx
            keeps every slide mounted: a screen reader and the tab key must
            reach all of them, not only whichever one a swipe left showing.
            No Pressable wraps the Image -- a photo here has no action (no
            category to filter, no WhatsApp chat to open, unlike a flyer),
            so wrapping it in a control would be exactly the false affordance
            about-panel.tsx's own header comment forbids for the proof chips,
            confirmed directly by storefront-touch-targets.test.tsx's
            ancestor walk. */}
        {images.map((image, i) => (
          <View key={image.id} style={{ width }}>
            <Image
              testID={i === 0 ? 'storefront-about-cover' : `storefront-about-photo-${image.id}`}
              source={{ uri: image.url! }}
              onError={() => onImageError(image.id)}
              style={[styles.photo, { backgroundColor: colors.soft, maxHeight: photoHeightCap }]}
              resizeMode="cover"
            />
          </View>
        ))}
      </ScrollView>

      {/* Hover-only arrows, the same gate flyer-carousel.tsx uses
          (`hoverCapable`/`armHover`/`supportsHover`) and for the same reason:
          a phone's synthesised "ghost hover" after a tap must never arm
          these, because on a phone -- see the dots' own comment below --
          they are `pointerEvents: 'none'` and the dots are the only way to
          change photo. */}
      <Pressable
        testID="storefront-about-prev"
        accessibilityRole="button"
        accessibilityLabel="Previous photo"
        onPress={() => goTo(index - 1)}
        onHoverIn={armHoverOn}
        onHoverOut={() => setArmHover(false)}
        hitSlop={10}
        pointerEvents={Platform.OS === 'web' && !armHover ? 'none' : 'auto'}
        style={pressable([
          styles.arrow, styles.arrowLeft, { backgroundColor: colors.ground },
          Platform.OS === 'web' && (armHover ? styles.arrowShown : styles.arrowHiddenWeb),
        ])}
      >
        <Text style={[styles.arrowGlyph, { color: colors.ink }]}>‹</Text>
      </Pressable>
      <Pressable
        testID="storefront-about-next"
        accessibilityRole="button"
        accessibilityLabel="Next photo"
        onPress={() => goTo(index + 1)}
        onHoverIn={armHoverOn}
        onHoverOut={() => setArmHover(false)}
        hitSlop={10}
        pointerEvents={Platform.OS === 'web' && !armHover ? 'none' : 'auto'}
        style={pressable([
          styles.arrow, styles.arrowRight, { backgroundColor: colors.ground },
          Platform.OS === 'web' && (armHover ? styles.arrowShown : styles.arrowHiddenWeb),
        ])}
      >
        <Text style={[styles.arrowGlyph, { color: colors.ink }]}>›</Text>
      </Pressable>

      {/* THE DOTS -- a Phase-3 CRITICAL on the flyer band's own dots (7px dot
          + hitSlop 8 = 23, well under the 44px floor) and, on a phone, the
          ONLY way to change photo: the arrows above sit at `opacity: 0` /
          `pointerEvents: 'none'` there. Copied verbatim from
          flyer-carousel.tsx's fixed shape rather than re-solved: the
          PRESSABLE is `TOUCH_TARGET` square and the visible dot inside it
          stays 7px. `hitSlop` was the fix tried and rejected there --
          7 + 8 + 8 = 23, and reaching 44 with slop alone needs +18/19 a
          side, which at a 6px gap overlaps the NEXT dot's own hit area
          instead of enlarging this one. A real box, sized in layout, is
          what makes each dot's 44px answer only to itself. */}
      <View style={styles.dots} testID="storefront-about-dots">
        {images.map((image, i) => (
          <Pressable
            key={image.id}
            testID="storefront-about-dot"
            accessibilityRole="button"
            accessibilityState={{ selected: i === index }}
            accessibilityLabel={`Photo ${i + 1} of ${count}`}
            onPress={() => goTo(i)}
            style={pressable(styles.dotTarget)}
          >
            {/* THE UNSELECTED DOT IS `edge`, NOT `soft` -- and that one token
                is the whole difference between two dots and one.
                flyer-carousel.tsx fills its unselected dots with `soft`, which
                reads there because its dots sit ON a photo band. These sit on
                the PAGE, and the page IS `soft`: measured in a browser, the
                unselected dot came out #f4f4f5 on a #f4f4f5 ground, 1.00:1 --
                a shop with two photographs showed exactly one dot and no sign
                there was anywhere to go. `edge` is the token derived for
                precisely this job: its own comment in storefront-catalog.ts
                says it bounds a CONTROL and is stepped against `soft` to clear
                WCAG 1.4.11's 3:1, which is the ratio a dot needs to be seen at
                all. */}
            <View style={[styles.dot, { backgroundColor: i === index ? colors.accent : colors.edge }]} />
          </Pressable>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  // `width: '100%'`, load-bearing the same way flyer-carousel.tsx's own
  // `band` style is and explains at length: this is the node `handleLayout`
  // measures, and the one child (the paging ScrollView) lays N photos side
  // by side with nothing clipping the un-scrolled sum -- a bare, width-less
  // View here would size itself from THAT content instead of its parent,
  // and two or more photos would re-enter the exact runaway that comment
  // documents. Photo count here is always at least 2 by the time this style
  // is reached (the `count === 1` branch above returns before it), so this
  // is not a theoretical risk carried over out of caution.
  gallery: { width: '100%' },
  photo: { width: '100%', aspectRatio: 16 / 9, borderRadius: RADIUS.inset },
  arrow: {
    position: 'absolute', top: '50%', marginTop: -15,
    width: 30, height: 30, borderRadius: 999,
    alignItems: 'center', justifyContent: 'center',
  },
  arrowLeft: { left: 8 },
  arrowRight: { right: 8 },
  arrowGlyph: { fontSize: 18, fontWeight: '800', lineHeight: 20 },
  arrowShown: { opacity: 1 },
  arrowHiddenWeb: { opacity: 0 },
  dots: { flexDirection: 'row', justifyContent: 'center', paddingTop: 9 },
  dotTarget: { width: TOUCH_TARGET, height: TOUCH_TARGET, alignItems: 'center', justifyContent: 'flex-start' },
  dot: { width: 7, height: 7, borderRadius: 999 },
});
