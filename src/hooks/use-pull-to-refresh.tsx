import { useCallback, useState, type ReactElement } from 'react';
import { RefreshControl, type RefreshControlProps } from 'react-native';

import { Colors } from '@/constants/theme';

// Pinned to the light palette for now — no dark-mode switching yet, matching
// the screens this appears on.
const theme = Colors.light;

// A pull-to-refresh control wired to a screen's own `reload`, ready to hand to
// a ScrollView's `refreshControl` prop.
//
// This is the manual counterpart to useRefreshOnFocus. That one covers coming
// BACK to a screen; this covers standing on one and wanting to know whether
// anything has changed — which is the only answer available for a second
// device, since nothing is pushed. A till rings up a sale and the owner's phone
// across the shop learns about it when they pull, or not at all.
//
// `refreshing` is tracked here rather than reusing the screen's own `loaded`
// flag: they mean different things. `loaded` is "has anything ever arrived",
// which is what decides whether to show a placeholder instead of the list.
// This is "is a user-initiated refresh in flight", which is what drives the
// spinner. Conflating them is how the list ends up replaced by a placeholder
// mid-pull — the bug that made the list jump back to the top on every edit.
export function usePullToRefresh(refresh: () => Promise<void> | void): ReactElement<RefreshControlProps> {
  const [refreshing, setRefreshing] = useState(false);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await refresh();
    } finally {
      // In a `finally` so a failed fetch still clears the spinner. The screen
      // surfaces the error itself; leaving the control spinning forever on top
      // of that would read as the app having hung.
      setRefreshing(false);
    }
  }, [refresh]);

  return <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.bentoMuted} colors={[theme.bentoInk]} />;
}
