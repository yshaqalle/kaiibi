import { useCallback, useState } from 'react';

import type { Product } from '@/types/models';

// What a scan left on the Inventory screen: the code in the search box, the
// product it resolved to, and the offer to create one when it resolved to
// nothing. One unit, because they are one answer to one scan -- keeping the
// code without the result would leave the box filtered to a product the screen
// no longer shows a bar for.
type InventorySession = {
  search: string;
  pinnedProduct: Product | null;
  unknownCode: string | null;
};

// Module-level, not component state, for exactly the reason `use-pos-session`
// gives: the admin shell renders the active tab through Expo Router's `<Slot />`
// rather than a persistent tab navigator, so InventoryScreen fully unmounts and
// every `useState` initializer runs again.
//
// Two things trigger that, and only one of them is obvious. Switching tabs is
// the known one. The other is CROSSING THE WIDTH BREAKPOINT on web: the shell
// returns two structurally different trees either side of `TABLET_BREAKPOINT`
// (a mobile header and bottom nav, or `AdminSidebar`), each with its own
// `<Slot />`, so React tears the whole screen down and builds it again. Dragging
// a window past 820px -- or rotating an iPad in a browser -- emptied the search
// box and took the scanned product's result bar with it.
//
// `scanFeedback` is deliberately NOT here. It is a four-second banner that says
// what just happened; surviving a remount would resurrect it minutes later,
// announcing a scan nobody had just made.
const session: InventorySession = {
  search: '',
  pinnedProduct: null,
  unknownCode: null,
};

export function useInventorySessionField<K extends keyof InventorySession>(key: K) {
  const [value, setValue] = useState<InventorySession[K]>(session[key]);
  // Stable identity (like the setter useState itself returns), so it's safe to
  // omit from effect/callback dependency arrays at call sites.
  const update = useCallback((next: InventorySession[K] | ((prev: InventorySession[K]) => InventorySession[K])) => {
    setValue((prev) => {
      const resolved = typeof next === 'function' ? (next as (prev: InventorySession[K]) => InventorySession[K])(prev) : next;
      session[key] = resolved;
      return resolved;
    });
  }, [key]);
  return [value, update] as const;
}

// Test seam. The store outlives every component that reads it, so a test that
// leaves a code in it would hand that code to the next test.
export function resetInventorySession() {
  session.search = '';
  session.pinnedProduct = null;
  session.unknownCode = null;
}
