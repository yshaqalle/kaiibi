import { useRouter } from 'expo-router';
import { Linking, Platform } from 'react-native';

import { DeviceNotice } from '@/components/ui/device-notice';
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
  const { can, activeLocation } = useAuth();
  const attached = useHardwareKeyboard();
  const scanner = useScannerSettings();
  const note = useCaveatDismissal('till.keyboard-detected', 'v1');
  // A separate key from the notice below, deliberately: they say opposite
  // things, and dismissing "you have not switched scanning on" must not also
  // silence "your keyboard is gone" months later when scanning IS on.
  const suppressed = useCaveatDismissal('till.keyboard-suppressed', 'v1');

  // `=== true` and not truthiness: `null` means detection could not answer, and
  // an unknown answer must never produce advice.
  if (attached !== true) return null;

  // Scanning is on and a scanner is plugged in -- so to the OS a keyboard is
  // attached, and Android answers that by refusing to show the on-screen one
  // to any app. Scanning keeps working; typing stops everywhere, with nothing
  // on screen connecting the two. The setting is `show_ime_with_hard_keyboard`,
  // which is a SECURE setting: an app cannot write it (that needs
  // WRITE_SECURE_SETTINGS, which Play-installed apps do not get), so the most
  // this can do is say what happened and open the screen that owns the switch.
  //
  // Android only. iOS behaves the same way and offers neither a setting nor an
  // API, so there is nowhere to send anyone -- and advice with no action is
  // what the notice below already refuses to give. Until the app carries its
  // own keypad into the forms, an iPad till has no answer worth printing.
  if (scanner.hardwareSetting) {
    if (Platform.OS !== 'android') return null;
    if (suppressed.dismissed) return null;
    // No permission gate, unlike below: this is the TABLET's setting, not the
    // shop's, so whoever is holding it can fix it whatever their role.
    return (
      <DeviceNotice
        glyph="⌨"
        onDismiss={suppressed.dismiss}
        action={{
          label: 'Open keyboard settings',
          // Lands on Physical keyboard, one row above the toggle. `sendIntent`
          // is Android-only, which the platform check above already guarantees.
          onPress: () => { void Linking.sendIntent('android.settings.HARD_KEYBOARD_SETTINGS'); },
        }}
      >
        Android switches the on-screen keyboard off while a scanner is connected, so staff
        can&apos;t type on this till. Turn on &quot;Show on-screen keyboard&quot; to get it back.
        Scanning is unaffected either way.
      </DeviceNotice>
    );
  }
  // Nobody who cannot act on it should be told about it.
  if (!can('settings.access')) return null;
  if (note.dismissed) return null;

  return (
    <DeviceNotice
      glyph="⌨"
      onDismiss={note.dismiss}
      action={{
        // Names the store so the reader knows where they'll land — the button
        // used to open the Locations panel and leave them to find the row.
        label: activeLocation ? `Set up scanning for ${activeLocation.name}` : 'Set up scanning',
        onPress: () =>
          router.push({
            pathname: '/settings',
            params: activeLocation ? { nav: 'locations', location: activeLocation.id } : { nav: 'locations' },
          }),
      }}
    >
      A keyboard or barcode scanner is connected to this device. If it&apos;s a scanner, turn on
      scanning for this store to use it.
    </DeviceNotice>
  );
}
