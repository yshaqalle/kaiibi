import { StyleSheet, View } from 'react-native';

import { Colors } from '@/constants/theme';

// Pinned to the light palette for now — no dark-mode switching yet.
const theme = Colors.light;

// A compact progress bar for budget-vs-actual rows. Modelled on GoalMeter's
// track/fill, but inline (no big value header) and with the sign flipped:
// exceeding a revenue goal is good, exceeding a spending budget is not, so the
// fill turns amber near the limit and red past it.
export function BudgetBar({ pctUsed }: { pctUsed: number | null }) {
  // No budget set — show an empty track rather than a full or zero bar, both
  // of which would imply a limit that was never agreed.
  if (pctUsed === null) {
    return <View style={[styles.track, { backgroundColor: theme.surfaceMuted }]} />;
  }

  const clamped = Math.max(0, Math.min(100, pctUsed));
  const fill = pctUsed > 100 ? theme.danger : pctUsed >= 90 ? theme.warning : theme.chartAccent;

  return (
    <View style={[styles.track, { backgroundColor: theme.surfaceMuted }]}>
      <View style={[styles.fill, { width: `${clamped}%`, backgroundColor: fill }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  track: { height: 7, borderRadius: 4, overflow: 'hidden' },
  fill: { height: '100%', borderRadius: 4 },
});
