import { NativeModule, requireNativeModule } from 'expo';

export type HardwareKeyboardEvents = {
  onChange(event: { attached: boolean }): void;
  /**
   * One hardware keystroke, reported from the Activity's window before any view
   * sees it -- so it arrives with nothing focused, which is the whole point.
   *
   * `key` follows the DOM's `KeyboardEvent.key`: a single character for
   * printable keys, or a name like 'Enter' or 'Tab'. Same vocabulary as the web
   * listener, so both platforms feed the same `stepWedge` machine.
   *
   * `at` is the moment the key was delivered natively, in the platform's
   * monotonic milliseconds. Compared only against other `at` values.
   */
  onKey(event: { key: string; at: number }): void;
  /**
   * An editor gained or lost focus, anywhere in the app. Reported by the OS
   * rather than by the fields themselves, so a screen written years from now is
   * covered without knowing this exists.
   */
  onEditorFocus(event: { focused: boolean }): void;
};

export declare class HardwareKeyboardModule extends NativeModule<HardwareKeyboardEvents> {
  isAttached(): boolean;
  /**
   * Missing from binaries built before key capture existed, so calling it is
   * how JS decides whether it may listen for keys instead of holding focus in
   * an invisible field. See `getHardwareKeyboardModule` for why a missing
   * native half must never throw.
   */
  supportsKeyEvents?(): boolean;
  /**
   * Type into whatever holds focus. The keypad's whole vocabulary: a keyboard
   * sends characters, it does not own the text.
   */
  /**
   * `tag` is the focused input's native view tag, from `findNodeHandle`. Passed
   * because a React Native modal is a separate window and the native side
   * cannot find a field inside one from the activity's window alone. `-1` means
   * "unknown" -- an optional argument is not a shape iOS exposes to JS.
   */
  insertText?(text: string, tag: number): void;
  deleteBackward?(tag: number): void;
  /** The terminator a scanner sends, from a finger: commits what was typed. */
  pressEnter?(tag: number): void;
  isEditorFocused?(): boolean;
  /**
   * Let go of the caret, at the platform's own level.
   *
   * `Keyboard.dismiss()` only blurs the field React Native's focus cache is
   * holding, and that cache is empty the moment a field unmounts while focused
   * -- while UIKit's responder chain can still be holding the dead one. Blurring
   * through both is what makes "I am done typing" mean it.
   */
  blurEditor?(): void;
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

/**
 * Can this binary deliver keystrokes without something being focused?
 *
 * Answered by asking rather than by a version, because the question is about
 * the BINARY the JS happens to be running inside -- a dev client or a store
 * build from before this existed loads today's bundle perfectly happily, and
 * on those the app must keep its old way of catching scans.
 */
export function supportsHardwareKeyEvents(): boolean {
  const module = getHardwareKeyboardModule();
  try {
    return module?.supportsKeyEvents?.() === true;
  } catch {
    return false;
  }
}

/**
 * Can this binary type into the focused field on the app's behalf?
 *
 * Same shape of question as `supportsHardwareKeyEvents`, and asked for the same
 * reason: a binary built before the keypad became a keyboard loads today's
 * bundle, and there the old per-screen keypad is still the only one that works.
 */
export function supportsTyping(): boolean {
  const module = getHardwareKeyboardModule();
  return typeof module?.insertText === 'function' && typeof module?.deleteBackward === 'function';
}
