import { useAuth } from '@/hooks/use-auth';
import { useHardwareKeyboard } from '@/hooks/use-hardware-keyboard';
import { resolveScannerSettings, type ScannerSettings } from '@/lib/scanner-settings';

export type { ScannerSettings };

// The single place that answers "does this till scan?".
//
// Every scan feature routes through here rather than reading the location
// itself, so the answer can't drift between screens -- and so that if the
// setting ever moves (to the business, or to the device) exactly one file
// changes.
//
// Two inputs, and they answer different halves. The STORE setting is
// permission: this shop uses scanners. The DEVICE says whether this particular
// till has one attached -- which the store column cannot express, since a shop
// runs on several devices and usually only one of them scans. The rules for
// combining them are in `resolveScannerSettings`, kept pure so all six cases
// are tested without a device.
export function useScannerSettings(): ScannerSettings {
  const { activeLocation } = useAuth();
  const keyboardAttached = useHardwareKeyboard();

  return resolveScannerSettings({
    camera: activeLocation?.barcodeScanningEnabled ?? false,
    hardwareSetting: activeLocation?.hardwareScannerEnabled ?? false,
    keyboardAttached,
  });
}
