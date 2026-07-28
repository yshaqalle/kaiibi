import { useEffect } from 'react';
import { Dimensions, Platform } from 'react-native';
import * as ScreenOrientation from 'expo-screen-orientation';

import { TABLET_BREAKPOINT } from '@/constants/layout';

// `Dimensions.get('screen')` reports the device's full physical screen,
// unlike `useWindowDimensions`/`Dimensions.get('window')` which reports the
// current app window and changes with rotation or Android split-screen. We
// need a rotation-stable signal to decide once whether a device is a
// tablet, not a value that could flip mid-session.
function isTabletDevice() {
  const { width, height } = Dimensions.get('screen');
  return Math.max(width, height) >= TABLET_BREAKPOINT;
}

// Phones stay portrait-locked (existing app-wide behavior via app.json).
// Tablets (iPad, Android tablets) are unlocked so the admin sidebar layout
// can actually use landscape width instead of being letterboxed into a
// portrait-shaped window.
export function useTabletOrientation() {
  useEffect(() => {
    // Web already reflows freely regardless of orientation; the browser's
    // Screen Orientation API also rejects outside fullscreen in most
    // browsers, so there's nothing useful to lock/unlock here.
    if (Platform.OS === 'web') return;

    if (isTabletDevice()) {
      ScreenOrientation.unlockAsync();
    } else {
      ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP);
    }
  }, []);
}
