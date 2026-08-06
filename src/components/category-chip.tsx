import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Colors } from '@/constants/theme';

// Pinned to the light palette for now — no dark-mode switching yet.
const theme = Colors.light;

export function CategoryChip({
  label,
  active,
  color,
  onPress,
  variant = 'default',
}: {
  label: string;
  active: boolean;
  color?: string | null;
  onPress: () => void;
  /**
   * `filter` is the compact pill used in a filter row. `bento` is that same
   * pill in the cool-grey world — it has to match the tab pills and the range
   * pill it sits under, which the cream border does not.
   */
  variant?: 'default' | 'filter' | 'bento';
}) {
  const bento = variant === 'bento';
  return (
    <Pressable
      onPress={onPress}
      role="button"
      aria-pressed={active}
      style={[
        styles.chip,
        (variant === 'filter' || bento) && styles.filterChip,
        bento && styles.chipBento,
        active && (bento ? styles.chipActiveBento : styles.chipActive),
      ]}
    >
      {color && <View style={[styles.dot, { backgroundColor: color }]} />}
      <Text style={[styles.chipText, bento && styles.chipTextBento, active && styles.chipTextActive]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  chip: { flexDirection: 'row', alignItems: 'center', gap: 7, backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#E2E2E2', paddingVertical: 11, paddingHorizontal: 20, borderRadius: 20 },
  filterChip: { flexShrink: 0, paddingVertical: 8, paddingHorizontal: 14, borderRadius: 999 },
  chipActive: { backgroundColor: '#111111', borderColor: '#111111' },
  chipBento: { backgroundColor: theme.bentoSurface, borderColor: theme.bentoLine, paddingVertical: 7, paddingHorizontal: 13 },
  chipActiveBento: { backgroundColor: theme.bentoInk, borderColor: theme.bentoInk },
  chipText: { fontSize: 13, fontWeight: '600', color: '#444444' },
  chipTextBento: { fontSize: 12, fontWeight: '700', color: theme.bentoInk2 },
  chipTextActive: { color: '#FFFFFF', fontWeight: '700' },
  dot: { width: 8, height: 8, borderRadius: 4 },
});
