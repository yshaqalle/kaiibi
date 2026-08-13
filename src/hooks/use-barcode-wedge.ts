import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';

import { getHardwareKeyboardModule, supportsHardwareKeyEvents } from '../../modules/hardware-keyboard';
import { DEFAULT_WEDGE_CONFIG, flushWedgeIfIdle, initialWedgeState, stepWedge, type WedgeConfig } from '@/lib/barcode-wedge';

// What happens when a burst goes quiet, shared by both listeners below: one
// machine, one silence rule, two sources of keys.
//
// Silence now ENDS a scan rather than discarding one. A scanner can be
// configured to send no suffix at all -- common on Bluetooth models -- and
// waiting for an Enter that is never coming lost the code entirely. Anything
// that reached `minLength` was delivered at machine speed, so it is a code
// whether or not a terminator follows it; anything shorter is dropped, exactly
// as before, so a stray keystroke cannot sit and prefix the next scan.
//
// Kept longer than the config's own `idleFlushMs`, so the flush is decided by
// the rule rather than by whichever timer happens to fire first.
const IDLE_SWEEP_MS = DEFAULT_WEDGE_CONFIG.idleFlushMs + 60;

/**
 * Does this build still need the invisible focused field to catch scans?
 *
 * True only on a native binary that cannot report keys -- a dev client or a
 * store build from before the module could. Everywhere else the window
 * listener above does the job without taking focus from anyone, and rendering
 * the sink as well would put back every problem it caused.
 *
 * Read once, in a state initialiser rather than at import: the native module
 * registers during startup, and a lookup at module-evaluation time can miss it
 * and answer for the life of the process.
 */
export function useWedgeSinkFallback(): boolean {
  const [needed] = useState(() => Platform.OS !== 'web' && !supportsHardwareKeyEvents());
  return needed;
}

// Listens for a hardware barcode scanner typing with nothing focused -- the way
// a real till is used, where the cashier scans without tapping into a field
// first.
//
// Web hears this from `document`. Native hears it from the Activity's window,
// through the `HardwareKeyboard` module, which is the same idea one layer down:
// a key reaches the window before any view sees it, so no field has to be
// focused to receive it. That matters more than it sounds. The previous native
// answer was an invisible TextInput that held focus forever, and holding focus
// is what fought modals for the caret, swallowed everything a real keyboard
// typed, and made Android raise the soft keyboard on every scan.
//
// On a binary built before the module could report keys, native falls back to
// that invisible field -- see `WedgeSink`, which callers still render for
// exactly that case.
export function useBarcodeWedge({
  enabled,
  onScan,
  config = DEFAULT_WEDGE_CONFIG,
}: {
  enabled: boolean;
  onScan: (code: string) => void;
  config?: WedgeConfig;
}): void {
  // Held in a ref so the listener doesn't need `onScan` in its deps. The
  // callback closes over the cart and product list, so it's a new function on
  // every render -- re-subscribing that often would tear down the listener
  // mid-burst and lose half a scanned code.
  const onScanRef = useRef(onScan);
  useEffect(() => { onScanRef.current = onScan; }, [onScan]);

  const stateRef = useRef(initialWedgeState());
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Native: keys from the window, with nothing focused.
  //
  // Bound to the screen being IN FRONT, not merely mounted. POS and Inventory
  // are tab screens and both stay mounted behind one another, so a plain effect
  // subscribed both: every scan was handled twice, by the screen the cashier is
  // looking at and by the one they are not -- adding to the cart while they
  // scan stock in. The same rule `WedgeSink` followed for the same reason.
  useFocusEffect(useCallback(() => {
    if (Platform.OS === 'web' || !enabled) return;
    const module = getHardwareKeyboardModule();
    if (!module || !supportsHardwareKeyEvents()) return;

    // No focus check here, deliberately. The native half already answers it --
    // against `window.currentFocus` at the instant the key arrives, the same
    // question the IME asks -- and only sends keys that no field wanted. Asking
    // again from JS means asking a DIFFERENT source: RN's
    // `currentlyFocusedInput()` is a cache, and it keeps a field that unmounted
    // while focused forever (see the note in `WedgeSink`). That stale entry made
    // every scan vanish here -- yielded to a field that no longer exists.
    const subscription = module.addListener('onKey', ({ key, at }) => {
      const step = stepWedge(stateRef.current, key, at, config);
      stateRef.current = step.state;
      if (step.emit) onScanRef.current(step.emit);

      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
      idleTimerRef.current = setTimeout(() => {
        const code = flushWedgeIfIdle(stateRef.current, Date.now(), config);
        stateRef.current = initialWedgeState();
        if (code) onScanRef.current(code);
      }, IDLE_SWEEP_MS);
    });

    return () => {
      subscription.remove();
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
      stateRef.current = initialWedgeState();
    };
  }, [enabled, config]));

  // Web: keys from the document.
  useEffect(() => {
    if (Platform.OS !== 'web' || !enabled) return;
    if (typeof document === 'undefined') return;

    const handler = (event: KeyboardEvent) => {
      // Someone is typing INTO something -- the product form's barcode field,
      // the search box, a note. Those fields handle their own scans (via
      // onSubmitEditing) and must keep every keystroke. This one check is what
      // lets the global listener and the focused-field path coexist instead of
      // fighting over the same keyboard.
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable) return;

      // Browser and OS shortcuts (Cmd+R, Ctrl+F). A scanner never sends these.
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      const step = stepWedge(stateRef.current, event.key, event.timeStamp, config);
      stateRef.current = step.state;

      if (step.consumed) {
        // Stop the scanner's trailing Enter from also activating whatever
        // button happens to have focus.
        event.preventDefault();
        event.stopPropagation();
      }
      if (step.emit) onScanRef.current(step.emit);

      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
      idleTimerRef.current = setTimeout(() => {
        const code = flushWedgeIfIdle(stateRef.current, Date.now(), config);
        stateRef.current = initialWedgeState();
        if (code) onScanRef.current(code);
      }, IDLE_SWEEP_MS);
    };

    // Capture phase: React's synthetic events run on a listener attached at the
    // root, so bubbling would let a focused element act on the terminator
    // before preventDefault could stop it.
    document.addEventListener('keydown', handler, true);
    return () => {
      document.removeEventListener('keydown', handler, true);
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
      stateRef.current = initialWedgeState();
    };
  }, [enabled, config]);
}
