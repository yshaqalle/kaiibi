import { useEffect, useRef, useState } from 'react';
import { findNodeHandle, Keyboard, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { getHardwareKeyboardModule, supportsTyping } from '../../modules/hardware-keyboard';
import { Colors } from '@/constants/theme';
import { useScannerSettings } from '@/hooks/use-scanner-settings';

const theme = Colors.light;

// How long focus has to STAY gone before the keyboard does. Long enough to
// cover a re-render's blur-and-refocus, short enough that putting a field away
// puts the keyboard away with it.
const BLUR_GRACE_MS = 600;

// Matches the native constant. `-1` rather than a null argument, because an
// optional parameter is not exposed to JS on iOS at all.
const NO_TAG = -1;

// The keys themselves, and the reasoning behind them, live in `till-keypad.tsx`.
// This file exists only so that the shop's settings -- and through them the auth
// context and Supabase -- are NOT in the import graph of `AppModal`, which every
// sheet in the app depends on. A modal wrapper that pulls in the database client
// makes the whole UI layer untestable and unbundleable on its own.
const DIGITS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'];

const LETTER_ROWS = [
  DIGITS,
  ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'],
  ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l'],
  ['z', 'x', 'c', 'v', 'b', 'n', 'm'],
];

// Everything a till actually types and nothing else. An email needs `@` and
// `.`, a phone number `+`, a note a comma and an apostrophe. There is no second
// symbol page: what is not here is not typed at a counter.
const SYMBOL_ROWS = [
  DIGITS,
  ['@', '.', '-', '_', '+', '/', ':', ';', '(', ')'],
  ['&', '%', '$', '#', '!', '?', ',', "'", '"'],
  ['*', '=', '<', '>', '[', ']', '~'],
];

// Off, armed for one character, or locked. One-shot by default because the
// common case is a single capital at the start of a name; double-tap locks for
// an all-caps SKU read off a label.
type Shift = 'off' | 'once' | 'lock';

/**
 * Is a field being typed into right now, anywhere in the app?
 *
 * Asked of the platform, not of React. A prop on each field would need every
 * field to know about the keypad; a read of RN's focus cache would inherit its
 * habit of remembering fields that have since unmounted.
 */
// How long after a keystroke the dock keeps handing focus back. A screen can
// blur the field twice over one key -- once on the local state change, again
// when an async search settles a moment later -- so a fixed pair of retries
// wins the first and loses the second. Bounded, and tied to typing, so a
// deliberate tap somewhere else a moment later is respected.
const HOLD_AFTER_KEY_MS = 1_500;

type FocusedInput = ReturnType<typeof TextInput.State.currentlyFocusedInput>;

// The field the dock is typing into, remembered across the re-renders that keep
// blurring it. A ref rather than state: it is read from a timer and must never
// cause a render of its own.
type TypingHold = { input: FocusedInput | null; until: number };

// Outside the component on purpose. Reading the clock is impure, and doing it in
// a function the compiler cannot see is only called from a press handler makes
// it look like render work.
function rememberTyping(hold: { current: TypingHold }, input: FocusedInput) {
  hold.current = { input, until: Date.now() + HOLD_AFTER_KEY_MS };
}

function useEditorFocused(hold: { current: TypingHold }): boolean {
  // The first answer comes from the initialiser rather than from the effect: a
  // screen can open with a field already autofocused, and waiting for a CHANGE
  // would leave that field with no keyboard at all -- while setting it inside
  // the effect is the cascading render the lint rule is right to refuse.
  const [focused, setFocused] = useState(() => getHardwareKeyboardModule()?.isEditorFocused?.() === true);

  useEffect(() => {
    const module = getHardwareKeyboardModule();
    if (!module || !supportsTyping()) return;
    // Only ever used to turn the dock ON. Turning it off is left to the poll
    // below, which can tell a real blur from the flicker of a re-render.
    const subscription = module.addListener('onEditorFocus', ({ focused: next }) => {
      if (next) setFocused(true);
    });

    // The native event only covers the ACTIVITY's window, and a modal is a
    // window of its own, so a field inside a sheet never announces itself.
    // React knows about all of them, so this poll fills that gap.
    //
    // Losing focus is believed only if it LASTS. Typing re-renders the screen
    // around the new value -- a customer search re-runs, a list appears -- and
    // the field can blur and refocus across that, which as an immediate signal
    // took the keyboard away after the very first key and dropped the next tap
    // onto whatever the sheet had moved under it. Gaining focus is acted on at
    // once; only the loss waits to be confirmed.
    let blurAt: number | null = null;
    const poll = setInterval(() => {
      // Mid-typing, an empty caret is the re-render's doing rather than the
      // user's, so the field gets it back instead of the keyboard closing.
      const held = hold.current;
      if (held.input && Date.now() < held.until && TextInput.State.currentlyFocusedInput() == null) {
        TextInput.State.focusTextInput(held.input);
      }

      const anyFocus =
        TextInput.State.currentlyFocusedInput() != null || module.isEditorFocused?.() === true;
      if (anyFocus) {
        blurAt = null;
        setFocused(true);
        return;
      }
      if (blurAt === null) blurAt = Date.now();
      if (Date.now() - blurAt >= BLUR_GRACE_MS) setFocused(false);
    }, 120);

    return () => { subscription.remove(); clearInterval(poll); };
  }, [hold]);

  return focused;
}

/**
 * Keeps the native key capture installed for as long as this till scans,
 * wherever the user happens to be.
 *
 * The screens that ACT on scans subscribe only while they are in front, which is
 * right -- a scan belongs to the screen being looked at. But capture lives or
 * dies with the last subscriber, so leaving POS and Inventory used to uninstall
 * it, and a scanner fired on the Dashboard went straight to the view hierarchy:
 * Android focused the first focusable thing to deliver the keys and the trailing
 * Enter pressed it. It opened the photo picker, repeatedly.
 *
 * So the routing is scoped and the SWALLOWING is not. This subscriber does
 * nothing with the keys; it exists so the wrapper stays installed.
 */
function useKeyCaptureAnchor(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    const module = getHardwareKeyboardModule();
    if (!module || !supportsTyping()) return;
    const subscription = module.addListener('onKey', () => {});
    return () => subscription.remove();
  }, [enabled]);
}

export function TillKeypadHost() {
  const scanner = useScannerSettings();
  const hold = useRef<TypingHold>({ input: null, until: 0 });
  const editorFocused = useEditorFocused(hold);
  useKeyCaptureAnchor(scanner.hardware);
  const [symbols, setSymbols] = useState(false);
  const [shift, setShift] = useState<Shift>('off');

  // Only where the system keyboard is actually being withheld, and only while
  // something is waiting for characters. Anywhere else this would be a second
  // keyboard on top of the real one.
  if (!scanner.onScreenKeypad || !editorFocused) return null;

  const module = getHardwareKeyboardModule();
  // Which field to type into, named by its React tag. The native side can find a
  // view by tag in ANY window; without it, a field inside a sheet -- which is a
  // window of its own -- cannot be reached at all.
  const tagOf = (focused: ReturnType<typeof TextInput.State.currentlyFocusedInput>) => {
    // On the New Architecture the focused input is a `ReactNativeElement` and
    // carries its own tag; `findNodeHandle` is the older path and still the
    // right fallback. Reading both keeps this working whichever renderer the
    // app is built against.
    const element = focused as unknown as
      | ({ __nativeTag?: number } & Parameters<typeof findNodeHandle>[0])
      | null;
    if (!element) return null;
    return element.__nativeTag ?? findNodeHandle(element) ?? null;
  };
  // Typing costs the field its focus, and giving it back is part of typing.
  //
  // The edit lands natively, the field reports it through `onChangeText`, and
  // the screen re-renders around the new value -- a customer search re-runs, a
  // result list appears. The field comes out of that commit unfocused, measured
  // and permanent: one key went in and the keyboard closed, because the keyboard
  // follows focus. Re-asserting AFTER the commit is what makes a second key
  // possible; doing it before, as the native side first tried, re-focuses a
  // field that has not lost focus yet.
  const withFocusKept = (act: (tag: number) => void) => {
    const input = TextInput.State.currentlyFocusedInput() ?? hold.current.input;
    act(tagOf(input) ?? NO_TAG);
    if (!input) return;
    // Remembered, then handed back by the poll for as long as typing is live.
    // Refocusing something already focused is a no-op, so this costs nothing on
    // the screens that never blur.
    rememberTyping(hold, input);
    setTimeout(() => TextInput.State.focusTextInput(input), 0);
  };

  const type = (text: string) => withFocusKept((tag) => module?.insertText?.(text, tag));

  // A letter carries the shift, and spends it. `lock` survives; `once` does not,
  // which is what makes a single capital cost one key rather than two.
  const typeLetter = (char: string) => {
    type(shift === 'off' ? char : char.toUpperCase());
    if (shift === 'once') setShift('off');
  };

  const toggleShift = () => setShift((current) => (current === 'off' ? 'once' : current === 'once' ? 'lock' : 'off'));
  const backspace = () => withFocusKept((tag) => module?.deleteBackward?.(tag));
  const enter = () => withFocusKept((tag) => module?.pressEnter?.(tag));

  return (
    // An overlay in the CURRENT window, never a modal of its own. A modal is a
    // separate window and takes focus when it appears, so a dock built that way
    // blurs the very field it opened for: tap a field, the dock appears, the
    // field loses focus, the dock hides itself again. Nothing visible happens
    // and the field is left unfocused, which is exactly what it did.
    //
    // Being in-window is also why `AppModal` renders one of these: a sheet is
    // another window, and this overlay cannot reach over it. See the note
    // there.
    <View style={styles.layer} pointerEvents="box-none">
        <View style={styles.dock}>
          <View style={styles.inner}>
            {(symbols ? SYMBOL_ROWS : LETTER_ROWS).map((row, index, rows) => {
              const last = index === rows.length - 1;
              // Half the missing width on each side, so a key is the same width
              // on every row and the hand can trust where it is. The last row
              // carries shift and backspace instead of padding, the way every
              // phone keyboard does.
              const spacerFlex = last ? 0 : (rows[0].length - row.length) / 2;
              return (
                <View key={index} style={styles.row}>
                  {spacerFlex > 0 ? <View style={{ flex: spacerFlex }} /> : null}
                  {last && !symbols ? (
                    <Pressable
                      onPress={toggleShift}
                      style={[styles.key, styles.wideKey, shift !== 'off' && styles.keyActive]}
                      accessibilityLabel={shift === 'lock' ? 'Caps lock on' : shift === 'once' ? 'Shift on' : 'Shift'}
                    >
                      <Text style={[styles.keyLabel, shift !== 'off' && styles.keyLabelActive]}>
                        {shift === 'lock' ? '⇪' : '⇧'}
                      </Text>
                    </Pressable>
                  ) : null}
                  {row.map((char) => (
                    <Pressable key={char} onPress={() => (symbols ? type(char) : typeLetter(char))} style={styles.key}>
                      <Text style={styles.keyLabel}>
                        {symbols ? char : shift === 'off' ? char : char.toUpperCase()}
                      </Text>
                    </Pressable>
                  ))}
                  {last ? (
                    <Pressable onPress={backspace} style={[styles.key, styles.wideKey]} accessibilityLabel="Backspace">
                      <Text style={styles.keyLabel}>⌫</Text>
                    </Pressable>
                  ) : null}
                  {spacerFlex > 0 ? <View style={{ flex: spacerFlex }} /> : null}
                </View>
              );
            })}

            <View style={styles.row}>
              <Pressable
                onPress={() => setSymbols((on) => !on)}
                style={[styles.key, styles.wideKey]}
                accessibilityLabel={symbols ? 'Letters' : 'Symbols and punctuation'}
              >
                <Text style={styles.keyLabel}>{symbols ? 'ABC' : '?123'}</Text>
              </Pressable>
              <Pressable onPress={() => type(' ')} style={[styles.key, styles.spaceKey]}>
                <Text style={styles.keyLabel}>space</Text>
              </Pressable>
              {/* What the scanner's trailing Enter does, for a code read off a
                  damaged label by eye. The field decides what it means -- search
                  here, resolve a barcode there -- exactly as it does for a
                  scan. */}
              <Pressable onPress={enter} style={[styles.key, styles.wideKey]} accessibilityLabel="Enter">
                <Text style={styles.keyLabel}>↵</Text>
              </Pressable>
              {/* Blur rather than a dock of its own to close: the dock follows
                  focus, so the honest way to put it away is to stop editing.
                  `Keyboard.dismiss` blurs whatever is focused, which is the
                  same thing this keypad is aimed at. */}
              <Pressable
                onPress={() => { hold.current = { input: null, until: 0 }; Keyboard.dismiss(); }}
                style={[styles.key, styles.doneKey]}
                accessibilityLabel="Done"
              >
                <Text style={[styles.keyLabel, styles.doneLabel]}>Done</Text>
              </Pressable>
            </View>
          </View>
        </View>
    </View>
  );
}

const styles = StyleSheet.create({
  // The dock sits at the bottom and the rest of the layer passes touches
  // through, so the screen behind stays usable -- scrolling a product list to
  // the field you want next, dismissing the sheet, pressing Apply.
  // Pinned to the bottom of whatever window it is in, and only as tall as the
  // dock: a full-height layer would sit over the screen even with
  // `box-none`, and every stray tap in the app would have to travel through it.
  layer: { position: 'absolute', left: 0, right: 0, bottom: 0 },
  dock: { backgroundColor: theme.bentoSoft, borderTopWidth: 1, borderTopColor: theme.bentoRule, paddingTop: 8, paddingBottom: 18 },
  inner: { paddingHorizontal: 6, gap: 8 },
  row: { flexDirection: 'row', gap: 6 },
  key: {
    flex: 1,
    height: 46,
    borderRadius: 10,
    backgroundColor: theme.bentoSurface,
    borderWidth: 1,
    borderColor: theme.bentoRule,
    alignItems: 'center',
    justifyContent: 'center',
  },
  spaceKey: { flex: 3 },
  // Shift and caps read as ON at a glance, because a keyboard that is silently
  // capitalising is how a customer's name ends up in shouting.
  keyActive: { backgroundColor: theme.bentoInk, borderColor: theme.bentoInk },
  keyLabelActive: { color: theme.bentoSurface },
  wideKey: { flex: 2 },
  doneKey: { flex: 2, backgroundColor: theme.bentoInk, borderColor: theme.bentoInk },
  doneLabel: { color: theme.bentoSurface },
  keyLabel: { fontSize: 16, fontWeight: '600', color: theme.bentoInk },
});
