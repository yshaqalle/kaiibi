import { useRouter } from 'expo-router';

import { Caveat } from '@/components/ui/caveat';
import { useAuth } from '@/hooks/use-auth';
import { useCaveatDismissal } from '@/hooks/use-caveat-dismissal';
import { useHardwareKeyboard } from '@/hooks/use-hardware-keyboard';
import { useScannerSettings } from '@/hooks/use-scanner-settings';

// A keyboard is plugged into this till and the store has not switched scanning
// on. Usually that is a shop that bought a scanner, connected it, and never
// found the setting.
//
// The mirror of this -- setting on, nothing attached -- is deliberately NOT a
// notice. Most devices in a shop are tablets and phones with no scanner, so it
// would fire on the majority of tills, describe no fault, and offer no action.
// This one fires only when someone physically connects something, is probably
// describing a fault, and has a one-toggle fix.
//
// It hedges on purpose. Detection cannot tell a scanner from a keyboard case,
// so the copy names what is actually known -- a keyboard -- and leaves the
// reader, who can see the cable, to decide. Asserting "scanner detected" to
// someone holding a keyboard tablet is a bug they can see.
export function TillKeyboardNotice() {
  const router = useRouter();
  const { can } = useAuth();
  const attached = useHardwareKeyboard();
  const scanner = useScannerSettings();
  const note = useCaveatDismissal('till.keyboard-detected', 'v1');

  // `=== true` and not truthiness: `null` means detection could not answer, and
  // an unknown answer must never produce advice.
  if (attached !== true) return null;
  if (scanner.hardwareSetting) return null;
  // Nobody who cannot act on it should be told about it.
  if (!can('settings.access')) return null;
  if (note.dismissed) return null;

  return (
    <Caveat
      tone="context"
      onDismiss={note.dismiss}
      action={{
        label: 'Open scanning settings',
        onPress: () => router.push({ pathname: '/settings', params: { nav: 'locations' } }),
      }}
    >
      A keyboard or barcode scanner is connected to this device. If it&apos;s a scanner, turn on
      scanning for this store to use it.
    </Caveat>
  );
}
