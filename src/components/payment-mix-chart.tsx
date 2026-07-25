import { StyleSheet, Text, View } from 'react-native';

import { Colors } from '@/constants/theme';
import type { PaymentMethod } from '@/types/models';

// Pinned to the light palette for now — no dark-mode switching yet.
const theme = Colors.light;

export type PaymentMixItem = { method: PaymentMethod; amountCents: number; pct: number };

// Fixed order + color slot per method (never re-derived from sort order) so
// a method's color and position stay stable as its share changes day to day.
const METHOD_ORDER: PaymentMethod[] = ['cash', 'zaad', 'edahab', 'other'];
const METHOD_LABEL: Record<PaymentMethod, string> = { cash: 'Cash', zaad: 'Zaad', edahab: 'eDahab', other: 'Other' };
const METHOD_SERIES_KEY: Record<PaymentMethod, 'chartSeries1' | 'chartSeries2' | 'chartSeries3' | 'chartSeries4'> = {
  cash: 'chartSeries1',
  zaad: 'chartSeries2',
  edahab: 'chartSeries3',
  other: 'chartSeries4',
};

export function PaymentMixChart({ items }: { items: PaymentMixItem[] }) {
  if (items.length === 0) {
    return <Text style={[styles.empty, { color: theme.textSecondary }]}>No payments recorded yet.</Text>;
  }

  const ordered = METHOD_ORDER.map((method) => items.find((item) => item.method === method)).filter(
    (item): item is PaymentMixItem => Boolean(item)
  );

  return (
    <View>
      <View style={[styles.bar, { backgroundColor: theme.surfaceMuted }]}>
        {ordered.map((item, i) => (
          <View
            key={item.method}
            style={[
              styles.segment,
              {
                width: `${Math.max(item.pct, 1)}%`,
                backgroundColor: theme[METHOD_SERIES_KEY[item.method]],
                borderRightWidth: i === ordered.length - 1 ? 0 : 2,
                borderRightColor: theme.surface,
              },
            ]}
          />
        ))}
      </View>
      <View style={styles.legend}>
        {ordered.map((item) => (
          <View key={item.method} style={styles.legendItem}>
            <View style={[styles.swatch, { backgroundColor: theme[METHOD_SERIES_KEY[item.method]] }]} />
            <Text style={[styles.legendName, { color: theme.text }]}>{METHOD_LABEL[item.method]}</Text>
            <Text style={[styles.legendPct, { color: theme.textSecondary }]}>{Math.round(item.pct)}%</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { flexDirection: 'row', height: 22, borderRadius: 6, overflow: 'hidden', marginBottom: 14 },
  segment: { height: '100%' },
  legend: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 6, minWidth: '45%' },
  swatch: { width: 10, height: 10, borderRadius: 3 },
  legendName: { fontSize: 11.5, fontWeight: '700', flex: 1 },
  legendPct: { fontSize: 11, fontWeight: '700' },
  empty: { fontSize: 13, paddingVertical: 4 },
});
