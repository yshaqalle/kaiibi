import { Platform } from 'react-native';

// The pure arithmetic behind "a mouse can drive a horizontal band it cannot
// natively drive" (Task 14's brief, first answered in flyer-carousel.tsx).
// RN-web's horizontal ScrollView answers touch and a drag scrollbar but not a
// mouse -- a vertical wheel over the band does nothing to it, and there is no
// way to grab and pan it. Two components now need exactly this: the flyer
// carousel (paged, snaps to a card) and the category band (free-scrolling,
// no pages). What differs between them is the EFFECTFUL wiring -- a ref, a
// non-passive `addEventListener('wheel', ...)`, pointer capture -- which
// stays local to each component because "snap to the nearest card" and "just
// clamp to the end of the row" are genuinely different policies. What is
// identical is this arithmetic, so it lives once, here, and both components
// import it rather than carrying a second copy that could drift.
//
// Kept pure and exported so a test can hold them directly: the reanimated
// mock this suite lives with discards props, and a mouse cannot be driven
// through react-test-renderer's fake DOM, so "rendered and dispatched a real
// wheel event" is not a test this harness can make -- but "given these
// numbers, what offset/index results" is.

// Which axis a wheel gesture means to pan by. A trackpad's two-finger swipe
// reports on deltaX directly; a mouse wheel (vertical only) reports on
// deltaY. Picking whichever axis carries the larger magnitude, rather than
// always deltaY, means both drive the same "wheel pans it" affordance
// through the same function.
export function wheelPanDelta(deltaX: number, deltaY: number): number {
  return Math.abs(deltaX) > Math.abs(deltaY) ? deltaX : deltaY;
}

// Keeps a scroll offset inside the band's own travel -- never negative,
// never past the end of it. Shared by the wheel and the drag paths, which
// both push a raw pixel delta at the current offset and need the same fence.
export function clampOffset(offset: number, maxOffset: number): number {
  return Math.max(0, Math.min(maxOffset, offset));
}

// The next scroll offset a single wheel tick produces, from the offset
// scrolled to so far. Pure arithmetic -- pan, then fence.
export function nextWheelOffset(offset: number, deltaX: number, deltaY: number, maxOffset: number): number {
  return clampOffset(offset + wheelPanDelta(deltaX, deltaY), maxOffset);
}

// Which card a given scroll offset is closest to. `width` is one slide's
// width and is assumed positive -- callers that cannot yet promise that
// (onLayout has not fired) guard before calling in rather than this function
// guessing. Only meaningful for a PAGED band (the flyer carousel); the
// category band has no pages to settle onto and never calls this.
export function nearestIndex(offset: number, width: number, count: number): number {
  return Math.max(0, Math.min(count - 1, Math.round(offset / width)));
}

// Whether this device can genuinely hover a pointer -- the `(hover: hover)`
// media query, read defensively. `window`/`matchMedia` are web-only globals
// (a real native device has neither), and even a browser that has them can
// answer "no" for a touch screen -- which is the whole point: gating hover on
// `Platform.OS === 'web'` alone is not enough, because that is TRUE in a
// phone's browser too, where mobile WebKit/Chrome synthesise a `mouseenter`
// after a tap ("ghost hover") that a platform-only gate cannot tell apart
// from a real mouse. Checked once, at mount, by every caller -- deciding
// whether hover can be ARMED AT ALL -- rather than trusted to fall out of
// "no mouse event fired", which a ghost hover event defeats by firing anyway.
export function supportsHover(): boolean {
  if (Platform.OS !== 'web') return false;
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  try {
    return window.matchMedia('(hover: hover)').matches;
  } catch {
    return false;
  }
}
