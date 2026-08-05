import { useEffect, useRef } from 'react';
import { Platform } from 'react-native';

import { DEFAULT_WEDGE_CONFIG, initialWedgeState, stepWedge, type WedgeConfig } from '@/lib/barcode-wedge';

// Listens for a hardware barcode scanner typing into the page with nothing
// focused -- the way a real till is used, where the cashier scans without
// clicking into a field first.
//
// WEB ONLY, deliberately. A wedge scanner is a keyboard, and React Native
// exposes no global hardware-key event on iOS or Android, so there is no honest
// way to implement this natively without an always-focused invisible TextInput
// (invasive enough that it belongs behind an explicit setting -- a later phase).
// On native this hook is a no-op and scanning works through the camera, or
// through the search field when it happens to be focused.
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

      // A burst that never gets its terminator -- a misread, or the cashier
      // walked away mid-scan -- must not sit in the buffer waiting to be
      // prefixed onto the next scan.
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
      idleTimerRef.current = setTimeout(() => { stateRef.current = initialWedgeState(); }, 250);
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
