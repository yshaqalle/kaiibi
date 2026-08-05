import { Dimensions } from 'react-native';
import * as Device from 'expo-device';

import { isTabletDevice } from '@/lib/device';

// `deviceType` is a native constant with no setter, so the module is mocked
// wholesale and the value swapped per case. `isTabletDevice` reads it at call
// time, which is what makes that swap take effect.
jest.mock('expo-device', () => ({
  DeviceType: { UNKNOWN: 0, PHONE: 1, TABLET: 2, DESKTOP: 3, TV: 4 },
  deviceType: null,
}));

function mockScreen(width: number, height: number) {
  jest.spyOn(Dimensions, 'get').mockReturnValue({ width, height, scale: 3, fontScale: 3 });
}

function setDeviceType(value: number | null) {
  (Device as { deviceType: number | null }).deviceType = value;
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('isTabletDevice', () => {
  // The regression this file exists for: the old check compared the LONGEST
  // screen side against the 820pt layout breakpoint, so every iPhone since
  // the 12 (844-932pt tall) was treated as a tablet, unlocked to landscape,
  // and then crashed on rotation.
  it('is false for an iPhone Pro Max, whose long side clears the tablet layout breakpoint', () => {
    setDeviceType(Device.DeviceType.PHONE);
    mockScreen(430, 932);
    expect(isTabletDevice()).toBe(false);
  });

  it('is true for a tablet', () => {
    setDeviceType(Device.DeviceType.TABLET);
    mockScreen(820, 1180);
    expect(isTabletDevice()).toBe(true);
  });

  it('trusts the device type over the screen size', () => {
    // A tablet held in landscape still reports TABLET; nothing about the
    // dimensions should be able to flip the answer mid-session.
    setDeviceType(Device.DeviceType.TABLET);
    mockScreen(1133, 744);
    expect(isTabletDevice()).toBe(true);
  });

  describe('when the native device type is unavailable', () => {
    it('falls back to the short side and rejects a phone', () => {
      setDeviceType(null);
      mockScreen(430, 932);
      expect(isTabletDevice()).toBe(false);
    });

    it('falls back to the short side and accepts an iPad mini', () => {
      setDeviceType(Device.DeviceType.UNKNOWN);
      mockScreen(744, 1133);
      expect(isTabletDevice()).toBe(true);
    });

    it('is orientation-independent in the fallback', () => {
      setDeviceType(null);
      mockScreen(1133, 744);
      expect(isTabletDevice()).toBe(true);
    });
  });
});
