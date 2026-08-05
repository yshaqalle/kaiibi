import { useEffect, useRef } from 'react';
import { Platform, StyleSheet, TextInput } from 'react-native';

import { normalizeBarcode } from '@/lib/barcode';

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
//   - `showSoftInputOnFocus={false}` suppresses the on-screen keyboard on
//     ANDROID ONLY. On iOS the prop does nothing; what saves us there is that
//     iOS hides the soft keyboard by itself whenever a hardware keyboard is
//     paired -- which is exactly the situation this exists for, and only that
//     situation. With no scanner paired, mounting this would pop the keyboard
//     over the register for no reason.
//   - It takes focus. Anything else that wants the keyboard has to win it back,
//     which is why every caller unmounts this while a modal is open rather than
//     leaving the two to fight.
//
// Scanners in SPP / BLE-serial mode are not keyboards and send nothing here;
// they need a vendor SDK and are out of scope. Users must set the scanner to
// HID / keyboard mode.
export function WedgeSink({ onScan }: { onScan: (code: string) => void }) {
  const inputRef = useRef<TextInput>(null);
  const bufferRef = useRef('');
  const onScanRef = useRef(onScan);
  useEffect(() => { onScanRef.current = onScan; }, [onScan]);

  useEffect(() => {
    // A frame's grace: focusing during the first layout pass loses the focus
    // again on some Android devices.
    const timer = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(timer);
  }, []);

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
      onBlur={() => { inputRef.current?.focus(); }}
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
