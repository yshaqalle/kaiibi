import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef } from 'react';

// How old a screen's data has to be before returning to it is worth a refetch.
//
// Not zero, because tab switching is constant at a counter -- POS to check a
// price, back, to Inventory, back -- and refetching on every one of those put
// 20 queries on the wire each time someone glanced at the Dashboard, on a till
// that is often on mobile data. A minute is short enough that nobody reads a
// stale figure for long and long enough that flicking between tabs is free.
//
// Exported so a screen with a genuine reason to differ can say so, and so the
// tests can state the boundary rather than hardcode it twice.
export const STALE_AFTER_MS = 60_000;

// Refetches a screen's data when the user navigates BACK to it, if what it is
// showing has gone stale.
//
// Needed because the phone shell keeps screens alive. `admin-tabs.tsx` renders
// NativeTabs -- a real UITabBarController -- so a phone never unmounts a tab it
// has already visited. Ring up a sale on POS, switch to Dashboard, and Dashboard
// is the same mounted component it was before the sale, showing the numbers it
// fetched then. Web and tablets don't have this problem: their shells render
// `<Slot />`, which unmounts the outgoing route, so returning remounts and
// refetches (see use-pos-session.ts, which exists because of that difference).
//
// Two things this deliberately does NOT do:
//
//   - It does not refetch on the focus that arrives with mounting. The screen's
//     own `useEffect(() => { reload(); }, [reload])` has just fetched, so the
//     clock below starts already fresh and that first focus falls inside the
//     window. Without this every cold open would fetch everything twice.
//
//   - It does not re-run when `refresh` changes identity. Reload callbacks here
//     are `useCallback`s over the date range, store filter and so on, so their
//     identity changes whenever those do -- and the screen's own effect already
//     refetches for that. Depending on it here would fire a second, duplicate
//     request for every filter change. The callback is held in a ref so the
//     focus subscription can stay mounted with an empty dependency list.
//
// This does not help a SECOND device: nothing is pushed, so a till that rings up
// a sale still leaves an owner's phone elsewhere showing old numbers until that
// screen is refocused past the window, or pulled. Realtime would be the answer
// there, and is not this.
export function useRefreshOnFocus(refresh: () => void, staleAfterMs: number = STALE_AFTER_MS) {
  const refreshRef = useRef(refresh);
  useEffect(() => {
    refreshRef.current = refresh;
  }, [refresh]);

  // Null until the first focus, which is the one that arrives with mounting.
  // Seeded there rather than from `useRef(Date.now())`, because reading the
  // clock during render is impure -- a re-render would move it.
  const lastRefreshedAt = useRef<number | null>(null);

  useFocusEffect(
    useCallback(() => {
      const now = Date.now();
      if (lastRefreshedAt.current === null) {
        // Mounting. The screen's own effect is fetching right now, so this
        // starts the clock rather than adding a second request.
        lastRefreshedAt.current = now;
        return;
      }
      if (now - lastRefreshedAt.current < staleAfterMs) return;
      lastRefreshedAt.current = now;
      refreshRef.current();
    }, [staleAfterMs])
  );
}
