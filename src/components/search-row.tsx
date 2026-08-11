import { useEffect, useRef, useState } from 'react';
import { Animated, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { Colors } from '@/constants/theme';
import { fieldBurstScan, initialFieldBurstState, stepFieldBurst } from '@/lib/barcode-wedge';

const theme = Colors.light;

// A hard on/off blink -- two zero-duration steps, not a fade -- because a
// caret is a state indicator, not an animation. Slow enough not to nag from
// the corner of the eye across a whole sale.
function BlinkingCaret() {
  // Lazy state, not a ref: the value is needed during render for the style,
  // and reading a ref's .current in render is off-limits to the compiler.
  const [opacity] = useState(() => new Animated.Value(1));

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 0, duration: 0, delay: 550, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 1, duration: 0, delay: 550, useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [opacity]);

  return <Animated.View style={[styles.caret, { opacity }]} />;
}

/**
 * Keypad open/closed, owned by the SCREEN rather than the row: the keypad
 * renders as a bottom dock at the screen root (a flex sibling of the
 * ScrollView), which the row cannot reach from inside the scroll flow.
 *
 * The unplug rule lives here so both screens inherit it: the scanner can be
 * unplugged with the keypad open, and closing rather than merely hiding means
 * plugging it back in does not silently reopen a keypad nobody asked for.
 */
export function useSearchKeypadState(useKeypad: boolean) {
  const [keypadOpen, setKeypadOpen] = useState(false);
  useEffect(() => {
    if (!useKeypad) setKeypadOpen(false);
  }, [useKeypad]);
  return { keypadOpen, setKeypadOpen };
}

/**
 * The search box, in its two worlds.
 *
 * With no hardware keyboard attached this is exactly what it has always been:
 * a `TextInput` and the system keyboard.
 *
 * With one attached it is NOT a `TextInput`, and that is the point rather than
 * a shortcut. A text field would take focus, and focus is what `WedgeSink`
 * needs to catch scans -- so touching the search box would stop the scanner
 * working. Rendering a `Pressable` and driving the text from our own keypad
 * means the field never asks for focus, the wedge keeps it, and a barcode
 * scanned mid-word still lands. Both work at once instead of taking turns.
 */
export function SearchRow({
  value,
  onChange,
  onSubmit,
  placeholder,
  useKeypad,
  showScanButton,
  onScanPress,
  showSearchIcon = false,
  size = 'desk',
  keypadOpen,
  onKeypadOpenChange,
}: {
  value: string;
  onChange: (next: string) => void;
  /**
   * Given the text to act on rather than reading the screen's own state, which
   * on the scan path is one render behind: a scan REPLACES the field, and the
   * replacement and the submit happen in the same tick.
   */
  onSubmit: (value: string) => void;
  placeholder: string;
  /** True only when a keyboard is CONFIRMED attached. See `resolveScannerSettings`. */
  useKeypad: boolean;
  showScanButton: boolean;
  onScanPress?: () => void;
  /** POS draws a leading glyph; Inventory does not. Keeps both looking as they do. */
  showSearchIcon?: boolean;
  /**
   * `counter` is the POS register: a bigger field and a bigger scan target,
   * because it is read at arm's length in shop lighting and pressed at a
   * counter rather than at a desk. `desk` is Inventory's.
   */
  size?: 'desk' | 'counter';
  /** From `useSearchKeypadState`. The screen renders the dock; the row only shows the caret. */
  keypadOpen: boolean;
  onKeypadOpenChange: (open: boolean) => void;
}) {
  const counter = size === 'counter';

  // A scanner typing into THIS field is not covered by either wedge: both of
  // them yield the keyboard to a field the user focused, and a text field
  // appends. Watching how fast the characters arrive is what separates the code
  // the scanner just typed from whatever the field was already showing. See
  // `stepFieldBurst`.
  const burstRef = useRef(initialFieldBurstState());
  // What the field last showed, which is NOT always the `value` prop: at three
  // milliseconds a character, a scan can outrun a commit, and a prop one render
  // behind would make the same characters look appended twice. Written on the
  // way out, so anything it does not match came from the screen instead.
  const shownRef = useRef(value);
  useEffect(() => {
    if (value === shownRef.current) return;
    // The screen set the box itself -- a camera scan, a wedge scan that landed
    // while nothing was focused, a cleared filter. None of those are typing, so
    // no burst survives them.
    shownRef.current = value;
    burstRef.current = initialFieldBurstState();
  }, [value]);

  const show = (next: string) => {
    shownRef.current = next;
    onChange(next);
  };
  const handleChangeText = (next: string) => {
    burstRef.current = stepFieldBurst(burstRef.current, shownRef.current, next, Date.now());
    show(next);
  };
  const handleSubmit = () => {
    const scan = fieldBurstScan(burstRef.current, Date.now());
    // A burst ends at its terminator either way, so a rejected one cannot leak
    // into the next.
    burstRef.current = initialFieldBurstState();
    // Null means a person typed this: leave the field exactly as it is. A code
    // means replace the field with it, so the box shows the product just
    // scanned rather than that code glued onto the end of the last one.
    if (scan !== null && scan !== shownRef.current) show(scan);
    onSubmit(scan ?? shownRef.current);
  };

  const icon = showSearchIcon ? (
    <Text style={[styles.icon, counter && styles.iconCounter]}>⌕</Text>
  ) : null;
  const scanButton = showScanButton ? (
    <Pressable
      onPress={onScanPress}
      style={[styles.scanButton, counter && styles.scanButtonCounter]}
      accessibilityLabel="Scan a barcode"
    >
      <Text style={[styles.scanGlyph, counter && styles.scanGlyphCounter]}>⛶</Text>
    </Pressable>
  ) : null;
  // A scanned code fills this box and, on Inventory, IS the result -- it is
  // what narrows the list to the thing just scanned. So it cannot auto-clear,
  // and until this existed there was no way out of it either: in keypad mode
  // the field is a Pressable with no caret to backspace, and the keypad's own
  // Clear key is behind a tap that raises the whole dock.
  //
  // A sibling of the field rather than a child, exactly as the scan button is,
  // so pressing it in keypad mode clears the text WITHOUT opening the keypad
  // and without the field ever asking for focus -- which is what would cost the
  // wedge the caret and kill scanning.
  const clearButton = value.length > 0 ? (
    <Pressable
      onPress={() => {
        // Emptying the box ends any burst in flight with it, so a scan half
        // delivered when it was pressed cannot finish into the empty field.
        burstRef.current = initialFieldBurstState();
        show('');
      }}
      style={[
        styles.clearButton,
        counter && styles.clearButtonCounter,
        // With no scan button beside it, it takes the outer slot instead.
        !showScanButton && (counter ? styles.clearButtonAloneCounter : styles.clearButtonAlone),
      ]}
      accessibilityRole="button"
      accessibilityLabel="Clear search"
      // Fingers at a counter, not a mouse at a desk: the glyph is small on
      // purpose (the scan button stays the loud one) but the target is not.
      hitSlop={8}
    >
      <Text style={[styles.clearGlyph, counter && styles.clearGlyphCounter]}>×</Text>
    </Pressable>
  ) : null;
  // Two controls at the right end need more room than one. Applied LAST in
  // every style array below, because `fieldCounter` carries a paddingRight of
  // its own that would otherwise win.
  const trailingRoom = !clearButton
    ? null
    : showScanButton
      ? (counter ? styles.fieldWithBothCounter : styles.fieldWithBoth)
      // Alone, the × sits where the scan button would have, so the room the
      // scan button needs is exactly right. `fieldCounter` already leaves it.
      : (counter ? null : styles.fieldWithScan);

  if (!useKeypad) {
    return (
      <View style={styles.wrap}>
        {icon}
        <TextInput
          value={value}
          onChangeText={handleChangeText}
          placeholder={placeholder}
          placeholderTextColor={theme.bentoMuted2}
          style={[styles.field, showSearchIcon && styles.fieldWithIcon, showScanButton && styles.fieldWithScan, counter && styles.fieldCounter, trailingRoom]}
          onSubmitEditing={handleSubmit}
          // A wedge scanner fires this on its trailing Enter; keeping focus
          // means the next scan lands here too instead of nowhere -- which is
          // exactly why `handleSubmit` has to replace the text rather than let
          // the next scan extend it.
          blurOnSubmit={false}
          returnKeyType="search"
          autoCapitalize="none"
          autoCorrect={false}
        />
        {clearButton}
        {scanButton}
      </View>
    );
  }

  return (
    <>
      <View style={styles.wrap}>
        {icon}
        <Pressable
          onPress={() => onKeypadOpenChange(true)}
          style={[styles.field, styles.fieldTappable, showSearchIcon && styles.fieldWithIcon, showScanButton && styles.fieldWithScan, counter && styles.fieldCounter, trailingRoom]}
          accessibilityRole="search"
        >
          {/* A row of its own, so the caret lands after the last character --
              as a direct child of the column field it dropped to the bottom-left
              corner, reading as an artifact rather than a caret. */}
          <View style={styles.valueRow}>
            {value ? (
              <Text style={styles.text} numberOfLines={1}>{value}</Text>
            ) : keypadOpen ? null : (
              // Says what it is: a thing you tap, with no cursor of its own.
              // Gone once the keypad is open: an empty live field shows a bare
              // caret, like a focused TextInput, not advice to tap a thing
              // already tapped.
              <Text style={styles.prompt} numberOfLines={1}>Tap to type, or scan</Text>
            )}
            {/* Our own caret: this is a Pressable, not a text input, so there is
                no system caret to show that it is receiving keys. */}
            {keypadOpen ? <BlinkingCaret /> : null}
          </View>
        </Pressable>
        {clearButton}
        {scanButton}
      </View>

      <View style={styles.live}>
        <View style={styles.liveDot} />
        {/* Green AND the word: colour alone is never the signal (see the bento
            tokens' note on deutan viewers). And it stays true while typing,
            which is the promise the whole design turns on. */}
        <Text style={styles.liveLabel}>Scanner ready</Text>
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'relative', justifyContent: 'center', marginBottom: 14 },
  field: {
    backgroundColor: theme.bentoSurface,
    borderWidth: 1,
    borderColor: theme.bentoRule,
    borderRadius: 14,
    height: 44,
    paddingHorizontal: 14,
    fontSize: 13,
    color: theme.bentoInk,
    justifyContent: 'center',
  },
  fieldTappable: { borderStyle: 'dashed' },
  fieldWithScan: { paddingRight: 46 },
  fieldWithIcon: { paddingLeft: 34 },
  // Room for the × as well as the scan button, so a long code truncates before
  // it reaches either.
  fieldWithBoth: { paddingRight: 78 },
  fieldWithBothCounter: { paddingRight: 92 },
  // POS: bigger field, read at arm's length in shop lighting rather than at a
  // desk. Layered over `field` (and `fieldWithIcon`/`fieldWithScan`), so the
  // desk sizes above stay visible and this doesn't need to repeat them.
  fieldCounter: { height: 52, paddingLeft: 42, paddingRight: 54, fontSize: 15 },
  icon: { position: 'absolute', left: 13, fontSize: 15, color: theme.bentoMuted2, zIndex: 1 },
  iconCounter: { left: 16, fontSize: 18 },
  live: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: -8, marginBottom: 12, paddingLeft: 2 },
  liveDot: { width: 7, height: 7, borderRadius: 3.5, backgroundColor: theme.bentoProfit },
  liveLabel: { fontSize: 10.5, fontWeight: '700', letterSpacing: 0.6, textTransform: 'uppercase', color: theme.bentoProfit },
  // `flexShrink` on the row, so a long value truncates inside the field
  // instead of pushing the caret out past the scan button.
  valueRow: { flexDirection: 'row', alignItems: 'center', flexShrink: 1, gap: 2 },
  text: { fontSize: 13, fontWeight: '600', color: theme.bentoInk, flexShrink: 1 },
  prompt: { fontSize: 13, color: theme.bentoMuted2 },
  caret: { width: 2, height: 16, backgroundColor: theme.bentoSeries1 },
  scanButton: {
    position: 'absolute',
    right: 6,
    height: 32,
    width: 32,
    borderRadius: 16,
    backgroundColor: theme.bentoInk,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Bigger than Inventory's, and black: scanning is the fastest way to find a
  // product here, and this is pressed at a counter rather than at a desk.
  scanButtonCounter: { height: 40, width: 40, borderRadius: 20, right: 6 },
  scanGlyph: {
    fontSize: 15,
    lineHeight: 15,
    color: theme.bentoSurface,
    // The ⛶ glyph has generous font metrics and drifts off-centre in the
    // circle on Android without these.
    includeFontPadding: false,
    textAlignVertical: 'center',
  },
  scanGlyphCounter: { fontSize: 17, lineHeight: 17 },
  // Ink, like the scan button beside it: a soft grey pill on a white field was
  // too quiet to find at a counter, which is the one moment it is wanted -- a
  // code is sitting in the box and the next scan is in your other hand.
  clearButton: {
    position: 'absolute',
    right: 44,
    height: 28,
    width: 28,
    borderRadius: 14,
    backgroundColor: theme.bentoInk,
    borderWidth: 1,
    borderColor: theme.bentoInk,
    alignItems: 'center',
    justifyContent: 'center',
  },
  clearButtonCounter: { right: 52, height: 34, width: 34, borderRadius: 17 },
  clearButtonAlone: { right: 6 },
  clearButtonAloneCounter: { right: 6 },
  clearGlyph: {
    fontSize: 15,
    lineHeight: 15,
    fontWeight: '600',
    // The DARK step of the loss token, not the light one. Red on ink is chosen
    // by the surface it sits on, not by the app's theme -- the light #d72b3e
    // reads 2.86:1 on `bentoInk`, under the 3:1 floor, where this clears 4.65:1.
    // Same rule the takings hero and the margin gauge follow.
    color: Colors.dark.bentoLoss,
    // Same metrics fix the ⛶ glyph needs above: without these the × drifts off
    // centre in its circle on Android.
    includeFontPadding: false,
    textAlignVertical: 'center',
  },
  clearGlyphCounter: { fontSize: 17, lineHeight: 17 },
});
