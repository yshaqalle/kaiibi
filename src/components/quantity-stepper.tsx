import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Colors } from '@/constants/theme';

// Pinned to the light palette for now — no dark-mode switching yet.
const theme = Colors.light;

// The cart's quantity control.
//
// Deliberately larger than the Inventory table's stepper (26px): that one is
// nudged occasionally at a desk, this one is pressed repeatedly at a counter
// with a customer waiting. The touch target is the design here; the palette is
// only what it is painted in.
export function QuantityStepper({ quantity, onChange }: { quantity: number; onChange: (next: number) => void }) {
  return (
    <View style={styles.row}>
      <Pressable
        onPress={() => onChange(Math.max(0, quantity - 1))}
        accessibilityLabel="Reduce quantity"
        hitSlop={6}
        style={({ pressed }) => [styles.button, pressed && styles.buttonPressed]}
      >
        <Text style={styles.buttonText}>−</Text>
      </Pressable>
      <Text style={styles.quantity}>{quantity}</Text>
      <Pressable
        onPress={() => onChange(quantity + 1)}
        accessibilityLabel="Increase quantity"
        hitSlop={6}
        style={({ pressed }) => [styles.button, pressed && styles.buttonPressed]}
      >
        <Text style={styles.buttonText}>+</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  // A track around the pair, so the control reads as one object rather than as
  // two loose circles either side of a number.
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    alignSelf: 'flex-start',
    backgroundColor: theme.bentoSoft,
    borderRadius: 999,
    paddingVertical: 4,
    paddingHorizontal: 6,
  },
  // A border, not just a fill: a bare circle on a soft track reads as disabled.
  button: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: theme.bentoSurface,
    borderWidth: 1,
    borderColor: theme.bentoLine,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonPressed: { backgroundColor: theme.bentoLine },
  buttonText: { color: theme.bentoInk, fontSize: 17, fontWeight: '800' },
  quantity: { minWidth: 22, textAlign: 'center', color: theme.bentoInk, fontWeight: '800', fontSize: 15, fontVariant: ['tabular-nums'] },
});
