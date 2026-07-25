import { StyleSheet, Text, View } from 'react-native';

import { Colors } from '@/constants/theme';

// Pinned to the light palette for now — no dark-mode switching yet.
const theme = Colors.light;

export type RankingItem = { name: string; value: number };

export function RankingChart({
  items,
  formatValue,
  emptyLabel,
}: {
  items: RankingItem[];
  formatValue: (value: number) => string;
  emptyLabel: string;
}) {
  if (items.length === 0) {
    return <Text style={[styles.empty, { color: theme.textSecondary }]}>{emptyLabel}</Text>;
  }

  const max = Math.max(1, ...items.map((item) => item.value));

  return (
    <View>
      {items.map((item) => (
        <View key={item.name} style={styles.row}>
          <Text style={[styles.name, { color: theme.text }]} numberOfLines={1}>{item.name}</Text>
          <View style={styles.track}>
            <View style={[styles.fill, { backgroundColor: theme.chartAccent, width: `${Math.max(4, (item.value / max) * 100)}%` }]} />
          </View>
          <Text style={[styles.value, { color: theme.textSecondary }]}>{formatValue(item.value)}</Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 6 },
  name: { flexBasis: 84, flexShrink: 0, fontSize: 11.5, fontWeight: '700' },
  track: { flex: 1, height: 18, justifyContent: 'center' },
  fill: { height: 16, borderRadius: 4 },
  value: { flexShrink: 0, fontSize: 11, fontWeight: '700' },
  empty: { fontSize: 13, paddingVertical: 4 },
});
