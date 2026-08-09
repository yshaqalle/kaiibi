import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Colors } from '@/constants/theme';
import { applyKey, type KeypadKey } from '@/lib/keypad';

const theme = Colors.light;

// An on-screen keypad for the search box, and only for that.
//
// It exists because iOS hides the system keyboard whenever a hardware keyboard
// is attached -- and a HID barcode scanner IS a hardware keyboard. So the one
// till that scans is the one till that cannot type, and there is no public API
// to ask for the keyboard back. This is that keyboard.
//
// It is NOT a general keyboard and must not grow into one: no shift, symbols,
// emoji, autocorrect, predictive bar or language switching. Product search is
// case-insensitive and matches name, SKU, brand, category, tag and barcode, so
// every one of those is weight with nothing on the other end.
//
// Digits sit on the top row rather than behind a mode switch, because barcodes
// get typed here as often as names.
const ROWS = [
  ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'],
  ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'],
  ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l'],
  ['z', 'x', 'c', 'v', 'b', 'n', 'm'],
];

export function SearchKeypad({
  value,
  onChange,
  onSubmit,
  onClose,
}: {
  value: string;
  onChange: (next: string) => void;
  /** Runs the same code path Enter does on a keyboard: resolve it as a scan. */
  onSubmit: () => void;
  onClose: () => void;
}) {
  const apply = (key: KeypadKey) => onChange(applyKey(value, key));

  return (
    <View style={styles.dock}>
      <View style={styles.inner}>
        {ROWS.map((row, index) => {
          // Half the missing width on each side, so a key is the same width on
          // every row and the hand can trust where it is. A FIXED spacer only
          // balances a row that is exactly one key short: the bottom row is three
          // short, and a fixed 0.5 left its keys about a quarter wider than the
          // letters above them.
          const spacerFlex = (ROWS[0].length - row.length) / 2;
          return (
            <View key={index} style={styles.row}>
              {spacerFlex > 0 ? <View style={{ flex: spacerFlex }} /> : null}
              {row.map((char) => (
                <Pressable
                  key={char}
                  onPress={() => apply({ type: 'char', value: char })}
                  style={styles.key}
                  accessibilityRole="button"
                  accessibilityLabel={char}
                >
                  <Text style={styles.keyLabel}>{char.toUpperCase()}</Text>
                </Pressable>
              ))}
              {spacerFlex > 0 ? <View style={{ flex: spacerFlex }} /> : null}
            </View>
          );
        })}

        <View style={styles.row}>
          <Pressable onPress={() => apply({ type: 'clear' })} style={[styles.key, styles.utilKey]} accessibilityRole="button">
            <Text style={styles.utilLabel}>Clear</Text>
          </Pressable>
          <Pressable onPress={() => apply({ type: 'space' })} style={[styles.key, styles.utilKey, styles.spaceKey]} accessibilityRole="button" accessibilityLabel="space">
            <Text style={styles.utilLabel}>space</Text>
          </Pressable>
          <Pressable onPress={() => apply({ type: 'delete' })} style={[styles.key, styles.utilKey]} accessibilityRole="button" accessibilityLabel="delete">
            <Text style={styles.utilLabel}>⌫</Text>
          </Pressable>
          <Pressable
            onPress={() => { onSubmit(); onClose(); }}
            style={[styles.key, styles.doneKey]}
            accessibilityRole="button"
          >
            <Text style={styles.doneLabel}>Done</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  dock: { backgroundColor: theme.bentoSoft, borderTopWidth: 1, borderTopColor: theme.bentoLine, padding: 10 },
  // The dock SURFACE spans the screen; the KEYS cap and centre so a tablet
  // till doesn't stretch them into a piano.
  inner: { width: '100%', maxWidth: 560, alignSelf: 'center', gap: 6 },
  row: { flexDirection: 'row', gap: 5 },
  key: {
    flex: 1,
    minWidth: 0,
    height: 40,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: theme.bentoRule,
    backgroundColor: theme.bentoSurface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  keyLabel: { fontSize: 15, fontWeight: '700', color: theme.bentoInk },
  utilKey: { backgroundColor: theme.bentoSoft },
  utilLabel: { fontSize: 12, fontWeight: '700', color: theme.bentoInk2 },
  spaceKey: { flex: 2.4 },
  doneKey: { flex: 1.5, backgroundColor: theme.bentoInk, borderColor: theme.bentoInk },
  doneLabel: { fontSize: 12.5, fontWeight: '800', color: theme.bentoSurface },
});
