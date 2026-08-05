import * as Device from 'expo-device';
import { Dimensions } from 'react-native';

// A tablet is defined by its SHORT side. The long side tells you nothing:
// an iPhone Pro Max is 932pt tall, taller than an iPad mini is wide (744pt).
// Comparing the long side against the 820pt *layout* breakpoint is what used
// to classify every iPhone since the 12 as a tablet — which unlocked them to
// landscape and crashed the app on rotation.
//
// Only used when the native device type is unavailable; 600 is the same
// smallest-width threshold Android uses to call a screen a tablet.
const TABLET_MIN_DIMENSION = 600;

// Device class, NOT layout width — the two were previously conflated. This
// answers "is this physically a tablet", is stable for the life of the
// process, and must never change with rotation. For "is the current window
// wide enough for the two-pane layout", use TABLET_BREAKPOINT against
// `useWindowDimensions()` instead.
export function isTabletDevice() {
  // Maps off UIUserInterfaceIdiom on iOS (.pad/.phone) and the smallest-width
  // screen class on Android, so it's the real answer where it's available.
  if (Device.deviceType != null && Device.deviceType !== Device.DeviceType.UNKNOWN) {
    return Device.deviceType === Device.DeviceType.TABLET;
  }

  // `Dimensions.get('screen')` is the full physical screen, unlike
  // `'window'`, which shrinks with Android split-screen. Both flip their
  // width/height on rotation, so compare the short side to stay
  // orientation-independent.
  const { width, height } = Dimensions.get('screen');
  return Math.min(width, height) >= TABLET_MIN_DIMENSION;
}
