import { useEffect, useState } from 'react';
import { Animated, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { Colors } from '@/constants/theme';

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
  onSubmit: () => void;
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

  if (!useKeypad) {
    return (
      <View style={styles.wrap}>
        {icon}
        <TextInput
          value={value}
          onChangeText={onChange}
          placeholder={placeholder}
          placeholderTextColor={theme.bentoMuted2}
          style={[styles.field, showSearchIcon && styles.fieldWithIcon, showScanButton && styles.fieldWithScan, counter && styles.fieldCounter]}
          onSubmitEditing={onSubmit}
          // A wedge scanner fires this on its trailing Enter; keeping focus
          // means the next scan lands here too instead of nowhere.
          blurOnSubmit={false}
          returnKeyType="search"
          autoCapitalize="none"
          autoCorrect={false}
        />
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
          style={[styles.field, styles.fieldTappable, showSearchIcon && styles.fieldWithIcon, showScanButton && styles.fieldWithScan, counter && styles.fieldCounter]}
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
});
