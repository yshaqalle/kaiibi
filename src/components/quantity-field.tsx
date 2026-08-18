import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { Colors } from '@/constants/theme';

// Pinned to the light palette, same as QuantityStepper.
const theme = Colors.light;

// A quantity you TYPE, with the steppers still there for a nudge.
//
// Separate from QuantityStepper rather than a flag on it, because they answer
// different questions. The cart's stepper is pressed repeatedly at a counter
// with a customer waiting, where a keyboard would be in the way; this one is
// used when redistributing stock, where the number is usually "all of them" or
// some round figure and forty taps is the whole complaint.
//
// `max` is what the source store holds. Passing it turns on the All button and
// the over-quantity styling, but does NOT clamp: a shop typing 9 into a field
// that says 4 is telling us something -- either a typo or a wrong count -- and
// silently rewriting it to 4 would hide both. The caller decides what to say.
export function QuantityField({
  quantity,
  onChange,
  max,
  label,
  // What the fill-to-max button says. Defaults to "All", but a screen that
  // already shows an "All" somewhere else should say what the button DOES --
  // Move stock renders a category filter whose first chip is "All", and two
  // controls a few pixels apart reading the same word is a coin toss.
  fillLabel = 'All',
}: {
  quantity: number;
  onChange: (next: number) => void;
  max?: number;
  label?: string;
  fillLabel?: string;
}) {
  const over = max !== undefined && quantity > max;
  const canFill = max !== undefined && max > 0 && quantity !== max;

  return (
    <View style={styles.wrap}>
      {canFill ? (
        <Pressable onPress={() => onChange(max)} hitSlop={6} accessibilityLabel={`${fillLabel} ${max}`}>
          <Text style={styles.all}>{fillLabel}</Text>
        </Pressable>
      ) : null}
      <View style={styles.row}>
        <Pressable
          onPress={() => onChange(Math.max(0, quantity - 1))}
          accessibilityLabel="Reduce quantity"
          hitSlop={6}
          style={({ pressed }) => [styles.button, pressed && styles.buttonPressed]}
        >
          <Text style={styles.buttonText}>−</Text>
        </Pressable>
        <TextInput
          value={quantity === 0 ? '' : String(quantity)}
          // Empty reads as 0, which is how a line is removed -- the same meaning
          // the stepper's minus already has when it reaches zero. Anything
          // non-numeric is dropped rather than rejected, so a stray letter from
          // a barcode scanner does not blank what was already typed.
          onChangeText={(text) => {
            const digits = text.replace(/[^0-9]/g, '');
            onChange(digits ? Number(digits) : 0);
          }}
          keyboardType="number-pad"
          inputMode="numeric"
          selectTextOnFocus
          placeholder="0"
          placeholderTextColor={theme.bentoMuted2}
          accessibilityLabel={label ?? 'Quantity'}
          style={[styles.input, over && styles.inputOver]}
        />
        <Pressable
          onPress={() => onChange(quantity + 1)}
          accessibilityLabel="Increase quantity"
          hitSlop={6}
          style={({ pressed }) => [styles.button, pressed && styles.buttonPressed]}
        >
          <Text style={styles.buttonText}>+</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  all: { fontSize: 11, fontWeight: '800', color: theme.bentoSeries1, letterSpacing: 0.3 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    alignSelf: 'flex-start',
    backgroundColor: theme.bentoSoft,
    borderRadius: 999,
    paddingVertical: 4,
    paddingHorizontal: 6,
  },
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
  // Bordered rather than bare: this one is a field, and a number that can be
  // typed into has to look different from one that can only be stepped.
  input: {
    minWidth: 54,
    height: 32,
    borderRadius: 9,
    borderWidth: 1.5,
    borderColor: theme.bentoRule,
    backgroundColor: theme.bentoSurface,
    textAlign: 'center',
    color: theme.bentoInk,
    fontWeight: '800',
    fontSize: 14,
    paddingVertical: 0,
    paddingHorizontal: 4,
    fontVariant: ['tabular-nums'],
  },
  inputOver: { borderColor: theme.bentoLoss, color: theme.bentoLoss },
});
