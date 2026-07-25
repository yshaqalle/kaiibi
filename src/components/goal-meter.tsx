import { StyleSheet, Text, View } from 'react-native';

import { Colors } from '@/constants/theme';
import { formatCents } from '@/lib/currency';

// Pinned to the light palette for now — no dark-mode switching yet.
const theme = Colors.light;

export function GoalMeter({ valueCents, goalCents }: { valueCents: number; goalCents: number }) {
  const pct = goalCents > 0 ? (valueCents / goalCents) * 100 : 0;
  const fillPct = Math.min(100, Math.max(0, pct));

  return (
    <View>
      <Text style={styles.value}>{formatCents(valueCents)}</Text>
      <Text style={styles.pct}>{Math.round(pct)}% of goal</Text>
      <View style={styles.track}>
        <View style={[styles.fill, { width: `${fillPct}%` }]} />
      </View>
      <View style={styles.captionRow}>
        <Text style={styles.caption}>0</Text>
        <Text style={styles.caption}>Goal {formatCents(goalCents)}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  value: { fontSize: 22, fontWeight: '800', letterSpacing: -0.5, color: theme.text },
  pct: { fontSize: 11.5, fontWeight: '700', color: theme.textSecondary, marginTop: 2, marginBottom: 10 },
  track: { height: 20, borderRadius: 10, backgroundColor: theme.surfaceMuted, overflow: 'hidden' },
  fill: { height: '100%', borderRadius: 10, backgroundColor: theme.chartAccent },
  captionRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 6 },
  caption: { fontSize: 10.5, fontWeight: '700', color: theme.textSecondary },
});
