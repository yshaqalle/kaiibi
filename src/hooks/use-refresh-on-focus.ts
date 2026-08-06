import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef } from 'react';

// Refetches a screen's data when the user navigates BACK to it.
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
//   - It skips the FIRST focus. Screens already fetch on mount via their own
//     `useEffect(() => { reload(); }, [reload])`, and firing here too would make
//     every cold open fetch everything twice.
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
// screen is refocused. Realtime would be the answer there, and is not this.
export function useRefreshOnFocus(refresh: () => void) {
  const refreshRef = useRef(refresh);
  useEffect(() => {
    refreshRef.current = refresh;
  }, [refresh]);

  // `useFocusEffect` runs its callback on every focus, including the one that
  // comes with mounting, so the first is swallowed here rather than by the
  // caller.
  const isFirstFocus = useRef(true);

  useFocusEffect(
    useCallback(() => {
      if (isFirstFocus.current) {
        isFirstFocus.current = false;
        return;
      }
      refreshRef.current();
    }, [])
  );
}
