import { Pressable, StyleSheet, Text } from 'react-native';

export function CategoryChip({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={[styles.chip, active && styles.chipActive]}>
      <Text style={[styles.chipText, active && styles.chipTextActive]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  chip: { backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#E2E2E2', paddingVertical: 8, paddingHorizontal: 16, borderRadius: 16 },
  chipActive: { backgroundColor: '#111111', borderColor: '#111111' },
  chipText: { fontSize: 12, fontWeight: '600', color: '#444444' },
  chipTextActive: { color: '#FFFFFF', fontWeight: '700' },
});
