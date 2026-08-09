import { NativeModule, requireNativeModule } from 'expo';

export type HardwareKeyboardEvents = {
  onChange(event: { attached: boolean }): void;
};

export declare class HardwareKeyboardModule extends NativeModule<HardwareKeyboardEvents> {
  isAttached(): boolean;
}

// Required lazily and cached, because `requireNativeModule` THROWS when the
// native half is missing -- which is the ordinary case for a JS bundle loaded
// into a binary built before this module existed. That must degrade to "we
// cannot answer", not take the app down on import.
//
// Only a SUCCESSFUL lookup is cached. Caching a failure too would mean one
// early miss -- e.g. called before the native side finishes registering --
// disables detection for the rest of the process with no way to recover.
let cached: HardwareKeyboardModule | undefined;

export function getHardwareKeyboardModule(): HardwareKeyboardModule | null {
  if (cached === undefined) {
    try {
      cached = requireNativeModule<HardwareKeyboardModule>('HardwareKeyboard');
    } catch {
      return null;
    }
  }
  return cached;
}
