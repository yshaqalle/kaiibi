import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform, StyleSheet, TextInput } from 'react-native';

import { flushSink, initialSinkState, stepSink } from '@/lib/barcode-wedge';

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
  // How much of the field has already been read out as a scan. See `stepSink`
  // in lib/barcode-wedge.ts for why the field's own emptiness cannot be relied
  // on to answer that.
  const sinkRef = useRef(initialSinkState());
  const textRef = useRef('');
  const onScanRef = useRef(onScan);
  useEffect(() => { onScanRef.current = onScan; }, [onScan]);

  // Tab screens stay mounted behind the active one, so POS and Inventory each
  // keep a live sink at all times -- and an invisible screen's sink holding
  // the caret means every scan lands on the screen the cashier ISN'T looking
  // at. Only the screen in front may claim; on the way to the back, the sink
  // lets go while still mounted, so the blur round-trips and the front
  // screen's sink finds a free caret rather than a foreign owner.
  const [screenActive, setScreenActive] = useState(false);
  const screenActiveRef = useRef(false);
  useFocusEffect(
    useCallback(() => {
      screenActiveRef.current = true;
      setScreenActive(true);
      return () => {
        screenActiveRef.current = false;
        setScreenActive(false);
        if (inputRef.current?.isFocused()) inputRef.current.blur();
      };
    }, [])
  );

  // The one rule, in one place: take the caret only when nothing else holds it.
  //
  // "Holds it" cannot be read straight off `currentlyFocusedInput()`, because
  // that cache lies in exactly one case: a TextInput unmounted while focused --
  // a modal's field, dismissed by a Save button -- sends its blur to a native
  // view already being torn down, so the answering blur event never arrives
  // and the cache keeps the dead field forever. Trusting it left every sink in
  // the app blocked until a full restart: scans went nowhere and the trailing
  // Enter clicked whatever view the OS had moved focus to instead.
  //
  // A live focused field always has its native view attached; the dead one's
  // `getNativeRef()` returns null. That is the tiebreak. Where the method
  // doesn't exist (older architectures), assume live -- which is simply the
  // old behavior: yield.
  const claimFocus = useCallback(() => {
    // Never while the screen is behind another -- the yield timer below can
    // fire after the tab switch that caused the blur it is answering.
    if (!screenActiveRef.current) return;
    const focused = TextInput.State.currentlyFocusedInput();
    if (focused != null) {
      const ref = (focused as unknown as { getNativeRef?: () => unknown }).getNativeRef;
      const stillMounted = typeof ref !== 'function' || ref.call(focused) != null;
      if (stillMounted) return;
    }
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (Platform.OS === 'web' || !screenActive) return;
    // A frame's grace: focusing during the first layout pass loses the focus
    // again on some Android devices.
    const mounted = setTimeout(claimFocus, 0);
    const reclaim = setInterval(claimFocus, RECLAIM_MS);
    return () => {
      clearTimeout(mounted);
      clearInterval(reclaim);
    };
  }, [claimFocus, screenActive]);

  const yieldTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (yieldTimer.current) clearTimeout(yieldTimer.current); }, []);

  // Web has a real global listener (useBarcodeWedge) and does not need -- or
  // want -- a focus-stealing input.
  if (Platform.OS === 'web') return null;

  const flush = () => {
    const step = flushSink(sinkRef.current, textRef.current);
    sinkRef.current = step.state;
    // Still worth asking for: when it does land, the field stops growing for
    // the life of the screen. When it doesn't -- which is the New
    // Architecture's answer, and the bug this used to be the only defence
    // against -- `stepSink` covers for it.
    inputRef.current?.clear();
    if (step.emit) onScanRef.current(step.emit);
  };

  return (
    <TextInput
      ref={inputRef}
      // Uncontrolled, deliberately. A controlled `value=""` only resets the
      // native text when a render happens to commit mid-burst -- usually never,
      // so each event's payload is the WHOLE accumulated text, and appending
      // payloads to a buffer turns one scanned code into every prefix of
      // itself glued together. The field is invisible, so the text piling up
      // in it costs nothing: `stepSink` reads only the part past the last scan.
      onChangeText={(text) => {
        // Full text, not a delta: that is `onChangeText`'s contract.
        textRef.current = text;
        // Some scanners deliver the whole code in one event including its
        // terminator, and never fire onSubmitEditing at all -- which is why
        // the terminator is recognised here as well as in `flush`.
        const step = stepSink(sinkRef.current, text, Date.now());
        sinkRef.current = step.state;
        if (step.emit) {
          inputRef.current?.clear();
          onScanRef.current(step.emit);
        }
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
