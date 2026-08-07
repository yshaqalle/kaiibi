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

export type RankingItem = {
  name: string;
  value: number;
  /**
   * A second figure under the bar — units when the bars are money, or the
   * reverse. Only for a measure the reader is choosing BETWEEN: printing the
   * one not being ranked is what lets a sort toggle re-order the rows without
   * hiding why the order changed.
   */
  caption?: string;
};

export function RankingChart({
  items,
  formatValue,
  emptyLabel,
  /** Numbers the rows. Worth it past about four, where position stops being obvious. */
  showRank = false,
  color,
  /**
   * Draw for a card sitting on `bentoInk` rather than on a white surface.
   *
   * A colour prop alone was not enough: the row name, the figure and the empty
   * bar track all read the light palette, and near-black text on a near-black
   * card is an invisible chart. The bar hue changes too — `chartAccent` is
   * chosen against white and drops to 2.4:1 on ink, under the 3:1 floor for a
   * chart mark.
   */
  onInk = false,
}: {
  items: RankingItem[];
  formatValue: (value: number) => string;
  emptyLabel: string;
  showRank?: boolean;
  color?: string;
  onInk?: boolean;
}) {
  const ink = onInk ? inkStyles : styles;
  if (items.length === 0) {
    return <Text style={ink.empty}>{emptyLabel}</Text>;
  }

  const max = Math.max(1, ...items.map((item) => item.value));
  const fillColor = color ?? (onInk ? theme.bentoSeries1 : theme.chartAccent);

  return (
    <View>
      {items.map((item, index) => {
        return (
          <View key={item.name} style={styles.row}>
            {showRank ? <Text style={ink.rank}>{index + 1}</Text> : null}
            <View style={styles.body}>
              <View style={styles.labelRow}>
                <Text style={ink.name} numberOfLines={1}>
                  {item.name}
                </Text>
                <Text style={ink.value}>{formatValue(item.value)}</Text>
              </View>
              <View style={ink.track}>
                {/* A 4% floor so a tiny-but-nonzero value still reads as a bar
                    rather than as nothing at all. */}
                <View style={[styles.fill, { backgroundColor: fillColor, width: `${Math.max(4, (item.value / max) * 100)}%` }]} />
              </View>
              {item.caption ? <Text style={ink.caption}>{item.caption}</Text> : null}
            </View>
          </View>
        );
      })}
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
  caption: { fontSize: 10.5, color: theme.textSecondary, marginTop: 3, fontVariant: ['tabular-nums'] },
});

// The same chart on `bentoInk`. Only the colours differ, so the layout above
// stays a single set of rules and cannot drift between the two grounds.
const inkStyles = StyleSheet.create({
  rank: { width: 16, fontSize: 11, fontWeight: '700', color: '#a6a6ae', fontVariant: ['tabular-nums'] },
  name: { flex: 1, minWidth: 0, fontSize: 12.5, fontWeight: '600', color: '#f2f2f5' },
  value: { fontSize: 12.5, fontWeight: '800', color: '#ffffff', fontVariant: ['tabular-nums'] },
  // A translucent white, not a token: the track has to sit on whatever
  // gradient the band happens to be painting behind it, and a fixed grey
  // would band against it.
  track: { height: 5, borderRadius: 3, backgroundColor: 'rgba(255,255,255,0.14)', marginTop: 5, overflow: 'hidden' },
  empty: { fontSize: 13, color: '#a6a6ae', paddingVertical: 4 },
  caption: { fontSize: 10.5, color: '#a6a6ae', marginTop: 3, fontVariant: ['tabular-nums'] },
});
