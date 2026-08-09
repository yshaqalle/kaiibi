import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { SearchKeypad } from '@/components/search-keypad';
import { Colors } from '@/constants/theme';

const theme = Colors.light;

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
}) {
  const [keypadOpen, setKeypadOpen] = useState(false);

  // The scanner can be unplugged with the keypad open. Closing rather than
  // merely hiding means plugging it back in does not silently reopen a keypad
  // nobody asked for, over the product grid.
  useEffect(() => {
    if (!useKeypad) setKeypadOpen(false);
  }, [useKeypad]);

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
          onPress={() => setKeypadOpen(true)}
          style={[styles.field, styles.fieldTappable, showSearchIcon && styles.fieldWithIcon, showScanButton && styles.fieldWithScan, counter && styles.fieldCounter]}
          accessibilityRole="search"
        >
          {value ? (
            <Text style={styles.text} numberOfLines={1}>{value}</Text>
          ) : (
            // Says what it is: a thing you tap, with no cursor of its own.
            <Text style={styles.prompt} numberOfLines={1}>Tap to type, or scan</Text>
          )}
          {/* Our own caret: this is a Pressable, not a text input, so there is
              no system caret to show that it is receiving keys. */}
          {keypadOpen ? <View style={styles.caret} /> : null}
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

      {keypadOpen ? (
        <SearchKeypad
          value={value}
          onChange={onChange}
          onSubmit={onSubmit}
          onClose={() => setKeypadOpen(false)}
        />
      ) : null}
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
  text: { fontSize: 13, fontWeight: '600', color: theme.bentoInk },
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
