import { StyleSheet, Text, View } from 'react-native';

import { Colors } from '@/constants/theme';
import { isFavourable, percentChange } from '@/lib/change';

const theme = Colors.light;

/**
 * How this figure moved against the same-length window before it.
 *
 * Renders NOTHING when there is no prior window to compare against — a period
 * the screen never fetched, or a baseline of zero. A dash or a "0%" would read
 * as a measured result; absence reads as what it is.
 *
 * The arrow is load-bearing. `lowerIsBetter` flips the colour without flipping
 * the arrow, so rising expenses point up and read red: direction and
 * desirability are different facts, and the badge has to carry both.
 */
export function DeltaBadge({
  current,
  previous,
  lowerIsBetter = false,
  onInk = false,
}: {
  current: number;
  previous: number | null | undefined;
  lowerIsBetter?: boolean;
  onInk?: boolean;
}) {
  const pct = percentChange(current, previous);
  if (pct === null || !Number.isFinite(pct)) return null;

  const rose = current - (previous ?? 0) >= 0;
  const good = isFavourable(current, previous ?? 0, lowerIsBetter);
  const palette = onInk ? ink : light;

  return (
    <View style={[styles.badge, good ? palette.good : palette.bad]}>
      <Text style={[styles.text, good ? palette.goodText : palette.badText]}>
        {`${rose ? '↑' : '↓'} ${Math.abs(pct).toFixed(0)}%`}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: { borderRadius: 999, paddingHorizontal: 8, paddingVertical: 3, alignSelf: 'flex-start' },
  text: { fontSize: 11, fontWeight: '800', fontVariant: ['tabular-nums'] },
});

// Washes rather than the full status hues: a saturated pill beside a figure
// competes with the figure. The TEXT carries the contrast.
const light = StyleSheet.create({
  good: { backgroundColor: theme.bentoUpWash },
  bad: { backgroundColor: theme.bentoDownWash },
  goodText: { color: theme.bentoUpInk },
  badText: { color: theme.bentoDownInk },
});

const ink = StyleSheet.create({
  good: { backgroundColor: 'rgba(46,184,114,0.22)' },
  bad: { backgroundColor: 'rgba(232,81,95,0.22)' },
  goodText: { color: Colors.dark.bentoProfit },
  badText: { color: Colors.dark.bentoLoss },
});

export { theme as deltaTheme };
