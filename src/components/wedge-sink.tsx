import { useCallback, useEffect, useRef } from 'react';
import { Platform, StyleSheet, TextInput } from 'react-native';

import { normalizeBarcode } from '@/lib/barcode';

// How long after losing focus the sink waits before deciding nobody else wanted
// it. A tap on a real field delivers the sink's blur and that field's focus as
// two separate native events, and not always in that order, so an immediate
// check would sometimes see an empty caret and steal it back.
const YIELD_GRACE_MS = 150;

// The sink cannot see the moment a field it yielded to is dismissed -- it
// blurred long before, so no event of its own fires -- and React Native has no
// focus-changed subscription to listen to. Without this poll, one tap on the
// search box would leave scanning dead until the screen remounted. Slow enough
// to be free, quick enough that a scan right after a keyboard closes lands.
const RECLAIM_MS = 700;

// Catches a Bluetooth barcode scanner on a phone or tablet when nothing is
// focused -- the native counterpart to the web's global key listener.
//
// React Native exposes no global hardware-keyboard event on either platform, so
// there is no listener to attach. The only way to receive those keystrokes is
// to have something focused that can receive them, which is what this is: a
// one-pixel, transparent, permanently-focused TextInput that exists solely to
// be typed into.
//
// That is invasive enough to require an explicit opt-in, which is why it is
// mounted only for a store whose settings say a scanner is actually connected
// (`hardwareScannerEnabled`, default off). Two reasons it must not be on by
// default:
//
//   - `showSoftInputOnFocus={false}` suppresses the on-screen keyboard. It is
//     NOT the iOS no-op it is often described as: RN implements it there by
//     hanging an empty `UIView` off the field's `inputView`, which in its own
//     words "hides keyboard, but keeps blinking cursor". Worth knowing because
//     Fabric's `prepareForRecycle` clears `inputAccessoryView` and not
//     `inputView`, and `_setShowSoftInputOnFocus:` only runs when the prop
//     CHANGES -- so a recycled view can in principle carry the empty input view
//     to the next TextInput that inherits it, which would look like a caret with
//     no keyboard. Never observed here; if it ever is, gate this prop to
//     Android, where the sink also genuinely needs it.
//
//     On iOS what saves us anyway is that the OS hides the soft keyboard by
//     itself whenever a hardware keyboard is paired -- which is exactly the
//     situation this exists for, and only that situation. With no scanner
//     paired, mounting this pops the keyboard over the register for no reason.
//   - It takes focus. Anything else that wants the keyboard has to win it back,
//     which is why every caller unmounts this while a modal is open rather than
//     leaving the two to fight.
//
// Within a screen it cannot unmount, so it yields instead: it only ever takes
// focus from NOBODY. That is the same rule the web listener follows by
// ignoring keydown when an INPUT is focused (see use-barcode-wedge.ts) -- a
// field the user tapped owns the keyboard, and the scan it receives is handled
// by that field's own onSubmitEditing.
//
// Scanners in SPP / BLE-serial mode are not keyboards and send nothing here;
// they need a vendor SDK and are out of scope. Users must set the scanner to
// HID / keyboard mode.
export function WedgeSink({ onScan }: { onScan: (code: string) => void }) {
  const inputRef = useRef<TextInput>(null);
  const bufferRef = useRef('');
  const onScanRef = useRef(onScan);
  useEffect(() => { onScanRef.current = onScan; }, [onScan]);

  // The one rule, in one place: take the caret only when nothing else holds it.
  const claimFocus = useCallback(() => {
    if (TextInput.State.currentlyFocusedInput() != null) return;
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (Platform.OS === 'web') return;
    // A frame's grace: focusing during the first layout pass loses the focus
    // again on some Android devices.
    const mounted = setTimeout(claimFocus, 0);
    const reclaim = setInterval(claimFocus, RECLAIM_MS);
    return () => {
      clearTimeout(mounted);
      clearInterval(reclaim);
    };
  }, [claimFocus]);

  const yieldTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (yieldTimer.current) clearTimeout(yieldTimer.current); }, []);

  // Web has a real global listener (useBarcodeWedge) and does not need -- or
  // want -- a focus-stealing input.
  if (Platform.OS === 'web') return null;

  const flush = () => {
    const code = normalizeBarcode(bufferRef.current);
    bufferRef.current = '';
    if (code) onScanRef.current(code);
  };

  return (
    <TextInput
      ref={inputRef}
      // Controlled empty, with the real text accumulated in a ref: leaving the
      // value in state would re-render the whole screen on every character of
      // every scan.
      value=""
      onChangeText={(text) => {
        bufferRef.current += text;
        // Some scanners deliver the whole code in one event including its
        // terminator, and never fire onSubmitEditing at all.
        if (/[\r\n\t]$/.test(text)) flush();
      }}
      onSubmitEditing={flush}
      // Without this the field blurs on submit and the next scan goes nowhere.
      blurOnSubmit={false}
      // Losing focus means one of two opposite things, so the answer waits
      // until it can tell them apart. The keyboard was dismissed and nothing
      // took over — take it back, or the next scan goes nowhere. Or the user
      // tapped a real field — and snatching it back from there is what made
      // the keyboard unusable on Inventory and the POS for any store with a
      // scanner switched on: the field focused, this blurred, this re-focused,
      // and the caret left before a character could land.
      onBlur={() => {
        if (yieldTimer.current) clearTimeout(yieldTimer.current);
        yieldTimer.current = setTimeout(claimFocus, YIELD_GRACE_MS);
      }}
      showSoftInputOnFocus={false}
      caretHidden
      autoCorrect={false}
      autoCapitalize="none"
      spellCheck={false}
      // Sized and faded rather than `display: none` or `width: 0`, both of
      // which make the field unfocusable and so useless for this.
      style={styles.sink}
      // It is not content; a screen reader announcing an empty text field that
      // can't be escaped would be worse than silence.
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    />
  );
}

const styles = StyleSheet.create({
  sink: { position: 'absolute', opacity: 0, height: 1, width: 1, top: 0, left: 0 },
});
