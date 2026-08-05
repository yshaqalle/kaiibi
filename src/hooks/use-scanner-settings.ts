import { useAuth } from '@/hooks/use-auth';

export type ScannerSettings = {
  // Show the Scan buttons and allow the camera scanner to open.
  camera: boolean;
  // Watch for a USB/Bluetooth keyboard-wedge scanner typing into the page.
  hardware: boolean;
  // Whether a typed/scanned code in a search box should be resolved as a scan
  // at all. True if either method is on -- someone with a wedge scanner and
  // someone typing a code by hand both expect Enter to find the product.
  resolveCodes: boolean;
};

// The single place that answers "does this till scan?".
//
// Every scan feature routes through here rather than reading the location
// itself, so the answer can't drift between screens -- and so that if the
// setting ever moves (to the business, or to the device) exactly one file
// changes.
//
// Resolved from the store this device is working in, because that is what the
// setting describes: the scanner is plugged into a particular counter. With no
// store resolved yet, scanning stays off rather than guessing -- a brief
// missing button is better than a global key listener nobody asked for.
export function useScannerSettings(): ScannerSettings {
  const { activeLocation } = useAuth();
  const camera = activeLocation?.barcodeScanningEnabled ?? false;
  const hardware = activeLocation?.hardwareScannerEnabled ?? false;
  return { camera, hardware, resolveCodes: camera || hardware };
}
