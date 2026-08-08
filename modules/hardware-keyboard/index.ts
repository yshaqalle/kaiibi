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
let cached: HardwareKeyboardModule | null | undefined;

export function getHardwareKeyboardModule(): HardwareKeyboardModule | null {
  if (cached === undefined) {
    try {
      cached = requireNativeModule<HardwareKeyboardModule>('HardwareKeyboard');
    } catch {
      cached = null;
    }
  }
  return cached;
}
