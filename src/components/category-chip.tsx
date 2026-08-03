import { Pressable, StyleSheet, Text, View } from 'react-native';

export function CategoryChip({ label, active, color, onPress, variant = 'default' }: { label: string; active: boolean; color?: string | null; onPress: () => void; variant?: 'default' | 'filter' }) {
  return (
    <Pressable onPress={onPress} style={[styles.chip, variant === 'filter' && styles.filterChip, active && styles.chipActive]}>
      {color && <View style={[styles.dot, { backgroundColor: color }]} />}
      <Text style={[styles.chipText, active && styles.chipTextActive]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  chip: { flexDirection: 'row', alignItems: 'center', gap: 7, backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#E2E2E2', paddingVertical: 11, paddingHorizontal: 20, borderRadius: 20 },
  filterChip: { flexShrink: 0, paddingVertical: 8, paddingHorizontal: 14, borderRadius: 999 },
  chipActive: { backgroundColor: '#111111', borderColor: '#111111' },
  chipText: { fontSize: 13, fontWeight: '600', color: '#444444' },
  chipTextActive: { color: '#FFFFFF', fontWeight: '700' },
  dot: { width: 8, height: 8, borderRadius: 4 },
});
