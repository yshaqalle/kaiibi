import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { PaymentMethod } from '@/types/models';

const prominentMethods: { key: PaymentMethod; label: string; icon: string }[] = [
  { key: 'cash', label: 'Cash', icon: '💵' },
  { key: 'zaad', label: 'ZAAD', icon: '📱' },
];

const moreMethods: { key: PaymentMethod; label: string }[] = [
  { key: 'edahab', label: 'e-Dahab' },
  { key: 'other', label: 'Other' },
];

export function PaymentMethodPicker({ value, onChange }: { value: PaymentMethod | null; onChange: (method: PaymentMethod) => void }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <View>
      <Text style={styles.heading}>PAYMENT METHOD</Text>
      <View style={styles.row}>
        {prominentMethods.map((method) => (
          <Pressable key={method.key} onPress={() => onChange(method.key)} style={[styles.button, value === method.key && styles.buttonActive]}>
            <Text style={[styles.buttonText, value === method.key && styles.buttonTextActive]}>{method.icon} {method.label}</Text>
          </Pressable>
        ))}
      </View>
      <Pressable onPress={() => setExpanded((current) => !current)}>
        <Text style={styles.moreToggle}>More options {expanded ? '▴' : '▾'}</Text>
      </Pressable>
      {expanded && (
        <View style={styles.row}>
          {moreMethods.map((method) => (
            <Pressable key={method.key} onPress={() => onChange(method.key)} style={[styles.moreButton, value === method.key && styles.buttonActive]}>
              <Text style={[styles.moreButtonText, value === method.key && styles.buttonTextActive]}>{method.label}</Text>
            </Pressable>
          ))}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  heading: { fontSize: 11, fontWeight: '700', color: '#999999', letterSpacing: 0.4, marginTop: 18, marginBottom: 8 },
  row: { flexDirection: 'row', gap: 8, marginBottom: 8 },
  button: { flex: 1, alignItems: 'center', paddingVertical: 14, paddingHorizontal: 8, borderRadius: 10, backgroundColor: '#F2F2F2' },
  buttonActive: { backgroundColor: '#111111' },
  buttonText: { fontSize: 13, fontWeight: '700', color: '#111111' },
  buttonTextActive: { color: '#FFFFFF' },
  moreToggle: { textAlign: 'center', fontSize: 11, color: '#999999', fontWeight: '700', textDecorationLine: 'underline', marginBottom: 8 },
  moreButton: { flex: 1, alignItems: 'center', paddingVertical: 10, paddingHorizontal: 8, borderRadius: 10, borderWidth: 1, borderColor: '#E2E2E2' },
  moreButtonText: { fontSize: 12, fontWeight: '600', color: '#666666' },
});
