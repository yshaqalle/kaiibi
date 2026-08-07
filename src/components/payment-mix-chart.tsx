import { StyleSheet, Text, View } from 'react-native';

import { Colors } from '@/constants/theme';
import type { PaymentMethod } from '@/types/models';

// Pinned to the light palette for now — no dark-mode switching yet.
const theme = Colors.light;

export type PaymentMixItem = { method: PaymentMethod; amountCents: number; pct: number };

// Fixed order + color slot per method (never re-derived from sort order) so
// a method's color and position stay stable as its share changes day to day.
const METHOD_ORDER: PaymentMethod[] = ['cash', 'zaad', 'edahab', 'other'];
const METHOD_LABEL: Record<PaymentMethod, string> = { cash: 'Cash', zaad: 'ZAAD', edahab: 'e-Dahab', other: 'Other' };
const METHOD_ICON: Record<PaymentMethod, string> = { cash: '💵', zaad: '📱', edahab: '📱', other: '•' };
// The bento series, not the cream `chartSeries*`: both callers (Dashboard and
// Accounting → Overview) are bento cards, and the legend beside this card is
// drawn from `bentoSeries*` — two ramps would put the swatch and the bar in
// visibly different blues.
const METHOD_SERIES_KEY: Record<PaymentMethod, 'bentoSeries1' | 'bentoSeries2' | 'bentoSeries3' | 'bentoSeries4'> = {
  cash: 'bentoSeries1',
  zaad: 'bentoSeries2',
  edahab: 'bentoSeries3',
  other: 'bentoSeries4',
};

// One row per method: what it is, what it took, and how big a share that is.
//
// Replaces a single stacked bar with a legend underneath. The stacked bar
// showed proportion well and the actual AMOUNTS not at all — you could see
// that cash was about half, but not that it was $784.50, which is the figure
// an owner reconciles against a till. Reading a share off the legend also
// meant matching a colour to a swatch, once per method.
export function PaymentMixChart({
  items,
  formatValue,
}: {
  items: PaymentMixItem[];
  /** Money formatter. Omit to show shares only. */
  formatValue?: (cents: number) => string;
}) {
  if (items.length === 0) {
    return <Text style={styles.empty}>No payments recorded yet.</Text>;
  }

  const ordered = METHOD_ORDER.map((method) => items.find((item) => item.method === method)).filter(
    (item): item is PaymentMixItem => Boolean(item)
  );

  return (
    <View>
      {ordered.map((item) => (
        <View key={item.method} style={styles.row}>
          <View style={styles.icon}>
            <Text style={styles.iconGlyph}>{METHOD_ICON[item.method]}</Text>
          </View>
          <View style={styles.body}>
            <View style={styles.topRow}>
              <Text style={styles.name}>{METHOD_LABEL[item.method]}</Text>
              {formatValue ? <Text style={styles.amount}>{formatValue(item.amountCents)}</Text> : null}
            </View>
            <View style={styles.track}>
              {/* A 1% floor so a method that took almost nothing still shows a
                  sliver rather than vanishing entirely. */}
              <View
                style={[
                  styles.fill,
                  { width: `${Math.max(item.pct, 1)}%`, backgroundColor: theme[METHOD_SERIES_KEY[item.method]] },
                ]}
              />
            </View>
            {/* "of takings", not a bare percent. This card sums to money
                COLLECTED, tax included — a share of a figure that is not
                revenue needs to say which figure it is a share of. */}
            <Text style={styles.pct}>{`${Math.round(item.pct)}% of takings`}</Text>
          </View>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 11, paddingVertical: 9 },
  icon: {
    width: 32,
    height: 32,
    borderRadius: 10,
    backgroundColor: theme.bentoSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconGlyph: { fontSize: 14 },
  body: { flex: 1, minWidth: 0 },
  topRow: { flexDirection: 'row', justifyContent: 'space-between', gap: 10 },
  name: { fontSize: 13.5, fontWeight: '700', color: theme.bentoInk },
  amount: { fontSize: 13.5, fontWeight: '800', color: theme.bentoInk, fontVariant: ['tabular-nums'] },
  track: { height: 6, borderRadius: 3, backgroundColor: theme.bentoLine, marginTop: 5, overflow: 'hidden' },
  fill: { height: '100%', borderRadius: 3 },
  pct: { fontSize: 11, color: theme.bentoMuted, fontWeight: '600', marginTop: 3, fontVariant: ['tabular-nums'] },
  empty: { fontSize: 13, color: theme.bentoMuted, paddingVertical: 4 },
});
