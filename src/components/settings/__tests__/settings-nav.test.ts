import { isSettingsNavId } from '@/components/settings/settings-sidebar';

describe('isSettingsNavId', () => {
  it('accepts a real panel id', () => {
    expect(isSettingsNavId('locations')).toBe(true);
  });

  // The guard exists because this value arrives from a URL, where anything
  // can be typed. A bad one must fall back, never render an empty screen.
  it('rejects anything that is not one', () => {
    expect(isSettingsNavId('nonsense')).toBe(false);
    expect(isSettingsNavId(undefined)).toBe(false);
    expect(isSettingsNavId(42)).toBe(false);
  });
});
