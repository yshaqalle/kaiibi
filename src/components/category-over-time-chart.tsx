import { StyleSheet, Text, View } from 'react-native';

import { Colors } from '@/constants/theme';
import { categoryColors } from '@/lib/category-colors';
import { formatCents } from '@/lib/currency';

// Pinned to the light palette for now — no dark-mode switching yet.
const theme = Colors.light;

const BAR_HEIGHT = 120;

export type MonthlyCategoryBucket = { label: string; segments: { category: string; revenueCents: number }[] };

export function CategoryOverTimeChart({ months }: { months: MonthlyCategoryBucket[] }) {
  if (months.length === 0 || months.every((m) => m.segments.every((s) => s.revenueCents === 0))) {
    return <Text style={styles.empty}>No sales yet in this range.</Text>;
  }

  // Stable category → color across every month, "Other" always last/muted
  // regardless of its rank, so a segment's color never shifts month to month.
  const totalsByCategory = new Map<string, number>();
  for (const month of months) {
    for (const segment of month.segments) {
      totalsByCategory.set(segment.category, (totalsByCategory.get(segment.category) ?? 0) + segment.revenueCents);
    }
  }
  const namedCategories = Array.from(totalsByCategory.keys())
    .filter((c) => c !== 'Other')
    .sort((a, b) => (totalsByCategory.get(b) ?? 0) - (totalsByCategory.get(a) ?? 0));
  const categoryOrder = totalsByCategory.has('Other') ? [...namedCategories, 'Other'] : namedCategories;
  // Shared with the donut above it, so a category is one colour on the whole
  // screen. Indexing into slots gave "Starter Kit" and "Esssence" the same
  // amber in two adjacent charts, purely for both ranking third.
  const palette = categoryColors(categoryOrder);
  const colorFor = (category: string) => palette.get(category) ?? theme.textSecondary;

  const monthTotal = (month: MonthlyCategoryBucket) => month.segments.reduce((sum, s) => sum + s.revenueCents, 0);
  const maxTotal = Math.max(1, ...months.map(monthTotal));

  return (
    <View>
      <View style={styles.chart}>
        {months.map((month) => {
          const total = monthTotal(month);
          const nonZero = month.segments.filter((s) => s.revenueCents > 0);
          return (
            <View key={month.label} style={styles.column}>
              <Text style={styles.totalLabel}>{total > 0 ? formatCents(total) : ''}</Text>
              <View style={styles.bar}>
                {nonZero.map((segment, i) => (
                  <View
                    key={segment.category}
                    style={[
                      styles.segment,
                      {
                        height: Math.max(2, (segment.revenueCents / maxTotal) * BAR_HEIGHT),
                        backgroundColor: colorFor(segment.category),
                        borderTopLeftRadius: i === nonZero.length - 1 ? 4 : 0,
                        borderTopRightRadius: i === nonZero.length - 1 ? 4 : 0,
                      },
                    ]}
                  />
                ))}
              </View>
              <Text style={styles.monthLabel}>{month.label}</Text>
            </View>
          );
        })}
      </View>
      <View style={styles.legend}>
        {categoryOrder.map((category) => (
          <View key={category} style={styles.legendItem}>
            <View style={[styles.swatch, { backgroundColor: colorFor(category) }]} />
            <Text style={styles.legendName} numberOfLines={1}>{category}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  chart: { flexDirection: 'row', alignItems: 'flex-end', gap: 10, height: BAR_HEIGHT + 40 },
  column: { flex: 1, alignItems: 'center' },
  totalLabel: { fontSize: 9.5, fontWeight: '700', color: theme.textSecondary, marginBottom: 4 },
  bar: { width: '100%', height: BAR_HEIGHT, justifyContent: 'flex-end', gap: 2 },
  segment: { width: '100%' },
  monthLabel: { fontSize: 10, fontWeight: '700', color: theme.textSecondary, marginTop: 6 },
  legend: { flexDirection: 'row', flexWrap: 'wrap', gap: 12, marginTop: 14 },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  swatch: { width: 9, height: 9, borderRadius: 3 },
  legendName: { fontSize: 11, fontWeight: '700', color: theme.text },
  empty: { fontSize: 13, color: theme.textSecondary, paddingVertical: 4 },
});
