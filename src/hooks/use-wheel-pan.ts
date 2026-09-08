import { useEffect, useRef } from 'react';
import {
  Platform, ScrollView,
  type LayoutChangeEvent, type NativeScrollEvent, type NativeSyntheticEvent,
} from 'react-native';

import { nextWheelOffset, shouldConsumeWheel, wheelPanDelta } from '@/lib/mouse-pan';

// A MOUSE WHEEL PANS A HORIZONTAL ROW. On web, react-native-web's horizontal
// ScrollView answers touch and a dragged scrollbar but not a wheel: a mouse
// over the row does nothing to it, so on a laptop or a desktop till any chip
// past the right edge of the row is unreachable without a trackpad. This hook
// is that affordance, packaged for any free-scrolling horizontal row -- the
// till's category chips are the first caller.
//
// The pure arithmetic lives in lib/mouse-pan.ts and is shared with the
// storefront's own two panning bands; what this file adds is the effectful
// wiring those two keep local for their own reasons (see that file's header).
// Deliberately WHEEL ONLY: the storefront bands also wire pointer-capture
// drag-to-grab, which is right for a row of photo tiles and wrong for a row of
// filter chips, where a click that moves a few pixels would be swallowed by
// the drag instead of toggling the chip under it.
//
// Native is a no-op: there is no wheel, and the returned handlers only track
// measurements nothing there reads.
export function useWheelPan(deps: unknown[] = []) {
  const ref = useRef<ScrollView>(null);
  const offsetXRef = useRef(0);
  const viewportWidthRef = useRef(0);
  const contentWidthRef = useRef(0);

  function maxOffset(): number {
    return Math.max(0, contentWidthRef.current - viewportWidthRef.current);
  }

  function handleLayout(event: LayoutChangeEvent) {
    viewportWidthRef.current = event.nativeEvent.layout.width;
  }

  function handleContentSizeChange(width: number) {
    contentWidthRef.current = width;
  }

  // Keeps `offsetXRef` honest against ANY scroll -- ours, or the browser's own
  // when the scrollbar is dragged or the row is swiped on a touch screen.
  function handleScrollSync(event: NativeSyntheticEvent<NativeScrollEvent>) {
    offsetXRef.current = event.nativeEvent.contentOffset.x;
  }

  // `shouldConsumeWheel` runs BEFORE `preventDefault()`. A row that already
  // fits its column has nowhere to pan, and a row scrolled to either end has
  // nowhere to pan in that direction -- in both cases the tick has to fall
  // through and scroll the page, or the row becomes a dead zone the page
  // cannot be scrolled through. See mouse-pan.ts for the full rule.
  function handleWheel(event: { deltaX: number; deltaY: number; preventDefault: () => void }) {
    const delta = wheelPanDelta(event.deltaX, event.deltaY);
    if (!shouldConsumeWheel(offsetXRef.current, maxOffset(), delta)) return;
    event.preventDefault();
    const next = nextWheelOffset(offsetXRef.current, event.deltaX, event.deltaY, maxOffset());
    offsetXRef.current = next;
    ref.current?.scrollTo({ x: next, animated: false });
  }

  // The listener is attached once per mount of the scrollable node, so it must
  // call the LATEST `handleWheel` closure rather than the one captured when it
  // was attached -- otherwise it reads stale measurements forever.
  const handleWheelRef = useRef(handleWheel);
  useEffect(() => {
    handleWheelRef.current = handleWheel;
  });

  // A JSX `onWheel` prop is routed through React's root-delegated,
  // `{ passive: true }` listener, which makes `preventDefault()` inside it a
  // silent no-op -- so the page would keep scrolling behind the row regardless.
  // `addEventListener` straight on the scrollable DOM node, non-passively, is
  // the one configuration that actually prevents it. On web `ref.current` IS
  // that node (react-native-web forwards the ref through); on native it is an
  // RN ScrollView instance with no such method, which the platform check and
  // the `addEventListener` probe below guard twice over.
  //
  // `deps` exists for callers whose row can unmount and remount -- pass
  // whatever decides that, the same way an effect would.
  useEffect(() => {
    if (Platform.OS !== 'web') return undefined;
    const node = ref.current as unknown as {
      addEventListener?: (type: 'wheel', cb: (event: WheelEvent) => void, options?: AddEventListenerOptions) => void;
      removeEventListener?: (type: 'wheel', cb: (event: WheelEvent) => void, options?: AddEventListenerOptions) => void;
    } | null;
    if (!node?.addEventListener) return undefined;
    const listener = (event: WheelEvent) => handleWheelRef.current(event);
    node.addEventListener('wheel', listener, { passive: false });
    return () => node.removeEventListener?.('wheel', listener, { passive: false });
    // A caller-supplied array cannot be statically verified, which is the
    // point: `deps` is exactly the escape hatch this hook offers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return {
    ref,
    // Spread onto the horizontal ScrollView, after any props of its own that
    // share these names.
    wheelPanProps: {
      onLayout: handleLayout,
      onContentSizeChange: handleContentSizeChange,
      onScroll: Platform.OS === 'web' ? handleScrollSync : undefined,
      scrollEventThrottle: Platform.OS === 'web' ? 16 : undefined,
    },
  } as const;
}
