import { useEffect } from 'react';
import { Platform } from 'react-native';
import * as ScreenOrientation from 'expo-screen-orientation';

// Every device rotates freely — phones included. This is only safe because the
// nav shell no longer changes shape with the window: admin-tabs.tsx picks
// between the bottom tab bar and the sidebar by DEVICE (see @/lib/device), so
// a phone turned sideways keeps its NativeTabs bar rather than swapping it for
// a different navigator mid-rotation, which used to crash the app.
//
// The unlock is NOT redundant with the Info.plist, which still lists portrait
// only for iPhone. expo-screen-orientation installs an app-delegate subscriber
// that answers `supportedInterfaceOrientationsFor:` out of its own registry and
// never reads the plist, so what this hook asks for is what iOS honours.
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
