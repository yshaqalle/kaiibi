import { useEffect } from 'react';
import { Platform } from 'react-native';
import * as ScreenOrientation from 'expo-screen-orientation';

// Every device rotates freely — phones included. This is only safe because the
// nav shell no longer changes shape with the window: admin-tabs.tsx picks
// between the bottom tab bar and the sidebar by DEVICE (see @/lib/device), so
// a phone turned sideways keeps its NativeTabs bar rather than swapping it for
// a different navigator mid-rotation, which used to crash the app.
//
// Two things outside this file have to agree for rotation to actually work, and
// both have bitten us:
//
//   1. `UISupportedInterfaceOrientations` in app.json must list the
//      orientations. iOS will not rotate into one the app doesn't declare, so
//      unlocking here is necessary but not sufficient.
//
//   2. Modals must go through `AppModal` (@/components/ui/app-modal), which
//      sets `supportedOrientations`. React Native defaults that prop to
//      `['portrait']`,
//      and a modal host is a presented view controller that answers
//      `supportedInterfaceOrientations` for ITSELF out of that prop -- neither
//      the plist nor this hook is consulted. A default-configured modal opened
//      in landscape therefore force-rotates the whole scene to portrait, and
//      several opening and closing in quick succession stack up
//      `_UIForcedOrientationTransactionToken`s that never commit, which makes
//      iOS suspend interaction: a screen fully drawn and idle that accepts no
//      touches at all. That is what froze the POS, which opens the most modals
//      in the shortest time (checkout sheet -> receipt).
export function useUnlockedOrientation() {
  useEffect(() => {
    // Web already reflows freely regardless of orientation; the browser's
    // Screen Orientation API also rejects outside fullscreen in most
    // browsers, so there's nothing useful to unlock here.
    if (Platform.OS === 'web') return;

    // Caught rather than left dangling: it's fire-and-forget, and a rejection
    // (an orientation the device won't support) would otherwise surface as an
    // unhandled promise rejection. Failing to change the lock is not worth
    // interrupting the app for.
    ScreenOrientation.unlockAsync().catch(() => {});
  }, []);
}
