export type ScannerSettings = {
  /** Show the Scan buttons and allow the camera scanner to open. */
  camera: boolean;
  /** Watch the keyboard for a wedge scanner typing into the screen. */
  hardware: boolean;
  /** Whether a typed or scanned code in a search box resolves as a scan. */
  resolveCodes: boolean;
  /** Replace the system keyboard with our own on this device. */
  onScreenKeypad: boolean;
};

/**
 * Two questions, answered from the same two inputs and deliberately not the
 * same way.
 *
 * `hardware` can afford optimism. When detection cannot answer, mounting the
 * wedge on a device with no scanner costs one unused invisible input, and NOT
 * mounting it would silently stop a shop that scans happily today.
 *
 * `onScreenKeypad` cannot. It replaces the system keyboard, so a wrong `true`
 * takes typing away from someone who had it. Only a confirmed answer earns
 * that, which is why `null` and `false` land the same way here and do not
 * above.
 *
 * `resolveCodes` is answered from the SETTING alone, with detection nowhere
 * near it: someone typing a barcode by hand and pressing Enter expects it to
 * find the product, and that is just as true on a tablet with no scanner.
 */
export function resolveScannerSettings({
  camera,
  hardwareSetting,
  keyboardAttached,
}: {
  camera: boolean;
  hardwareSetting: boolean;
  keyboardAttached: boolean | null;
}): ScannerSettings {
  return {
    camera,
    hardware: hardwareSetting && (keyboardAttached ?? true),
    resolveCodes: camera || hardwareSetting,
    onScreenKeypad: hardwareSetting && keyboardAttached === true,
  };
}
