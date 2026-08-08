import { resolveScannerSettings } from '@/lib/scanner-settings';

const base = { camera: false, hardwareSetting: true, keyboardAttached: null as boolean | null };

describe('resolveScannerSettings', () => {
  it('mounts the wedge when a keyboard is confirmed', () => {
    const s = resolveScannerSettings({ ...base, keyboardAttached: true });
    expect(s.hardware).toBe(true);
    expect(s.onScreenKeypad).toBe(true);
  });

  // The gate doing its work: a store that uses scanners, on a tablet that has none.
  it('does not mount the wedge on a device with no keyboard', () => {
    const s = resolveScannerSettings({ ...base, keyboardAttached: false });
    expect(s.hardware).toBe(false);
    expect(s.onScreenKeypad).toBe(false);
  });

  // The one case where the two answers diverge, and the reason both exist.
  // An unused invisible input costs nothing; replacing someone's keyboard with
  // ours on a guess costs them their typing.
  it('trusts the setting for the wedge but never for the keypad when detection cannot answer', () => {
    const s = resolveScannerSettings({ ...base, keyboardAttached: null });
    expect(s.hardware).toBe(true);
    expect(s.onScreenKeypad).toBe(false);
  });

  it('gives nothing at all when the store has not enabled scanning', () => {
    for (const keyboardAttached of [true, false, null]) {
      const s = resolveScannerSettings({ ...base, hardwareSetting: false, keyboardAttached });
      expect(s.hardware).toBe(false);
      expect(s.onScreenKeypad).toBe(false);
    }
  });

  // Deliberately NOT gated on detection. Someone typing a barcode by hand and
  // pressing Enter expects it to find the product, and that is true on a
  // tablet with no scanner attached to it. Gating this would be a regression
  // dressed up as a fix.
  it('still resolves typed codes on a device with no scanner', () => {
    const s = resolveScannerSettings({ ...base, keyboardAttached: false });
    expect(s.resolveCodes).toBe(true);
  });

  it('resolves typed codes for a camera-only store', () => {
    const s = resolveScannerSettings({ camera: true, hardwareSetting: false, keyboardAttached: false });
    expect(s.resolveCodes).toBe(true);
    expect(s.hardware).toBe(false);
  });

  it('resolves nothing when neither method is on', () => {
    const s = resolveScannerSettings({ camera: false, hardwareSetting: false, keyboardAttached: true });
    expect(s.resolveCodes).toBe(false);
  });
});
