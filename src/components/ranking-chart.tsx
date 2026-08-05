import { StyleSheet, Text, View } from 'react-native';

import { Colors } from '@/constants/theme';

// Pinned to the light palette for now — no dark-mode switching yet.
const theme = Colors.light;

// "Which of these is biggest": one bar per row, sorted, longest at 100%.
//
// The name and figure sit on one line ABOVE a full-width bar, rather than in
// three columns beside it. The old three-column form gave the name an 84px
// basis, which truncated most real product names — "Nido milk powder 900g"
// and "Basmati rice 5kg" both became ellipses, and a ranking whose labels are
// unreadable ranks nothing.
//
// One hue for the whole chart, never a palette. The comparison here is LENGTH;
// colouring each bar differently implies a category dimension that isn't
// present. Use lib/category-colors.ts only where category really is the point.

export type RankingItem = { name: string; value: number };

export function RankingChart({
  items,
  formatValue,
  emptyLabel,
  /** Numbers the rows. Worth it past about four, where position stops being obvious. */
  showRank = false,
  color = theme.chartAccent,
}: {
  items: RankingItem[];
  formatValue: (value: number) => string;
  emptyLabel: string;
  showRank?: boolean;
  color?: string;
}) {
  if (items.length === 0) {
    return <Text style={styles.empty}>{emptyLabel}</Text>;
  }

  const max = Math.max(1, ...items.map((item) => item.value));

  return (
    <View>
      {items.map((item, index) => (
        <View key={item.name} style={styles.row}>
          {showRank ? <Text style={styles.rank}>{index + 1}</Text> : null}
          <View style={styles.body}>
            <View style={styles.labelRow}>
              <Text style={styles.name} numberOfLines={1}>
                {item.name}
              </Text>
              <Text style={styles.value}>{formatValue(item.value)}</Text>
            </View>
            <View style={styles.track}>
              {/* A 4% floor so a tiny-but-nonzero value still reads as a bar
                  rather than as nothing at all. */}
              <View style={[styles.fill, { backgroundColor: color, width: `${Math.max(4, (item.value / max) * 100)}%` }]} />
            </View>
          </View>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 11, paddingVertical: 7 },
  rank: { width: 16, fontSize: 11, fontWeight: '700', color: theme.textSecondary, fontVariant: ['tabular-nums'] },
  body: { flex: 1, minWidth: 0 },
  labelRow: { flexDirection: 'row', justifyContent: 'space-between', gap: 12 },
  name: { flex: 1, minWidth: 0, fontSize: 12.5, fontWeight: '600', color: theme.text },
  value: { fontSize: 12.5, fontWeight: '800', color: theme.text, fontVariant: ['tabular-nums'] },
  track: { height: 5, borderRadius: 3, backgroundColor: theme.backgroundElement, marginTop: 5, overflow: 'hidden' },
  fill: { height: '100%', borderRadius: 3 },
  empty: { fontSize: 13, color: theme.textSecondary, paddingVertical: 4 },
});
