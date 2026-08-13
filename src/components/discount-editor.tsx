import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { useAuth } from '@/hooks/use-auth';
import type { Discount } from '@/types/models';

// A small inline "% or $ off" entry used both for a single cart line and
// for the whole-transaction discount in the POS — same shape either way,
// just a type toggle plus a value.
export function DiscountEditor({
  initial,
  onApply,
  onRemove,
}: {
  initial?: Discount | null;
  onApply: (discount: Discount) => void;
  onRemove?: () => void;
}) {
  const [type, setType] = useState<'percentage' | 'fixed'>(initial?.type ?? 'percentage');
  const [value, setValue] = useState(initial ? (initial.type === 'fixed' ? (initial.value / 100).toFixed(2) : String(initial.value)) : '');

  // The one discount path with no ceiling and no record of why. A cashier
  // without this may still apply the shop's own offers — they just cannot
  // invent an amount. Rendering nothing rather than a disabled control: an
  // affordance that refuses is worse than no affordance.
  const { can } = useAuth();
  if (!can('discounts.manual')) return null;

  const apply = () => {
    const num = Number(value);
    if (!num || num <= 0) return;
    onApply({ type, value: type === 'fixed' ? Math.round(num * 100) : Math.min(num, 100) });
  };

  return (
    <View style={styles.row}>
      <View style={styles.typeToggle}>
        <Pressable onPress={() => setType('percentage')} style={[styles.typeButton, type === 'percentage' && styles.typeButtonActive]}>
          <Text style={[styles.typeButtonText, type === 'percentage' && styles.typeButtonTextActive]}>%</Text>
        </Pressable>
        <Pressable onPress={() => setType('fixed')} style={[styles.typeButton, type === 'fixed' && styles.typeButtonActive]}>
          <Text style={[styles.typeButtonText, type === 'fixed' && styles.typeButtonTextActive]}>$</Text>
        </Pressable>
      </View>
      <TextInput
        value={value}
        onChangeText={setValue}
        placeholder={type === 'percentage' ? '10' : '5.00'}
        placeholderTextColor="#999999"
        keyboardType="decimal-pad"
        style={styles.input}
        onSubmitEditing={apply}
      />
      <Pressable onPress={apply} style={styles.applyButton}><Text style={styles.applyButtonText}>Apply</Text></Pressable>
      {onRemove && initial && (
        <Pressable onPress={onRemove}><Text style={styles.removeText}>Remove</Text></Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 6 },
  typeToggle: { flexDirection: 'row', backgroundColor: '#F2F2F2', borderRadius: 8, overflow: 'hidden' },
  typeButton: { paddingVertical: 6, paddingHorizontal: 10 },
  typeButtonActive: { backgroundColor: '#111111' },
  typeButtonText: { fontSize: 12, fontWeight: '700', color: '#666666' },
  typeButtonTextActive: { color: '#FFFFFF' },
  input: { flex: 1, backgroundColor: '#F2F2F2', borderRadius: 8, height: 32, paddingHorizontal: 10, fontSize: 12, color: '#111111', minWidth: 56 },
  applyButton: { backgroundColor: '#111111', borderRadius: 8, paddingVertical: 6, paddingHorizontal: 12 },
  applyButtonText: { color: '#FFFFFF', fontSize: 12, fontWeight: '700' },
  removeText: { color: '#C0392B', fontSize: 12, fontWeight: '700' },
});
