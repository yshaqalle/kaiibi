import { Pressable, StyleSheet, Text, View } from 'react-native';

export function QuantityStepper({ quantity, onChange }: { quantity: number; onChange: (next: number) => void }) {
  return (
    <View style={styles.row}>
      <Pressable onPress={() => onChange(Math.max(0, quantity - 1))} style={styles.button}><Text style={styles.buttonText}>−</Text></Pressable>
      <Text style={styles.quantity}>{quantity}</Text>
      <Pressable onPress={() => onChange(quantity + 1)} style={styles.button}><Text style={styles.buttonText}>+</Text></Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  button: { width: 28, height: 28, borderRadius: 14, backgroundColor: '#EEF2EB', alignItems: 'center', justifyContent: 'center' },
  buttonText: { color: '#17261F', fontSize: 16, fontWeight: '800' },
  quantity: { minWidth: 20, textAlign: 'center', color: '#17261F', fontWeight: '800' },
});
