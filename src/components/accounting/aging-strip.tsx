import { Pressable, StyleSheet, Text, View } from 'react-native';

import { BENTO_RADIUS_TILE, Colors } from '@/constants/theme';
import { formatCompactCents } from '@/lib/currency';
import type { AgingBucket, AgingTotal } from '@/lib/aging';

const theme = Colors.light;

/**
 * How old the money is, as four tiles above a list.
 *
 * This IS the aging report. It is not a screen of its own, because the tab it
 * sits on already answers who owes what and since when -- the only thing an
 * aging schedule adds is the total per bucket, and a second screen listing the
 * same people with the same amounts in a different order is two places to look
 * for one question and a guarantee that one day they disagree.
 *
 * So the strip is a LENS on the list beneath it. Pressing a tile filters the
 * table; pressing it again clears. The Reports hub still gets its card, and
 * that card opens this tab with a bucket already chosen -- the same move the
 * three statement cards make onto the Accounting tab.
 */
export function AgingStrip({
  totals,
  selected,
  onSelect,
}: {
  totals: AgingTotal[];
  /** Null is the tab's ordinary state: no filter, whole list. */
  selected: AgingBucket | null;
  onSelect: (bucket: AgingBucket | null) => void;
}) {
  return (
    <View style={styles.row}>
      {totals.map((total) => {
        const active = selected === total.key;
        // The oldest bucket is the one worth noticing, and only when it holds
        // something. Amber rather than red: money owed late is a task, not a
        // loss -- and it carries the words "90+ days" beside it, so the colour
        // is never the only signal.
        const alarming = total.key === 'd90' && total.cents > 0;
        return (
          <Pressable
            key={total.key}
            onPress={() => onSelect(active ? null : total.key)}
            style={[styles.tile, active && styles.tileOn]}
            role="button"
            aria-selected={active}
            accessibilityLabel={`${total.label}, ${total.count} of them. ${active ? 'Showing only these. Press to clear.' : 'Press to show only these.'}`}
          >
            <Text style={[styles.label, active && styles.labelOn]}>{total.label}</Text>
            <Text style={[styles.value, active && styles.valueOn, alarming && !active && styles.valueAlarm]}>
              {formatCompactCents(total.cents)}
            </Text>
            {/* The count, not the boundary hint, once there is anything in the
                bucket: "2 customers" is the actionable half, and the boundary is
                already in the label above it. An empty bucket keeps the hint,
                because "under 30 days old" explains a zero where "0 customers"
                just repeats it. */}
            <Text style={[styles.hint, active && styles.hintOn]} numberOfLines={1}>
              {total.count === 0 ? total.hint : total.count === 1 ? '1 of them' : `${total.count} of them`}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  // Wraps to 2x2 on a phone rather than scrolling: four tiles is a shape you
  // take in at a glance, and a horizontal scroller hides the oldest bucket --
  // which is the one that matters most -- off the right edge.
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  tile: {
    flexGrow: 1,
    flexBasis: 150,
    backgroundColor: theme.bentoSoft,
    borderRadius: BENTO_RADIUS_TILE,
    padding: 14,
    // A hairline that only shows when selected would make the tile jump by a
    // pixel on press, so it is always there and only changes colour.
    borderWidth: 1,
    borderColor: 'transparent',
  },
  tileOn: { backgroundColor: theme.bentoSurface, borderColor: theme.bentoRule },
  label: { fontSize: 10.5, fontWeight: '800', letterSpacing: 0.7, textTransform: 'uppercase', color: theme.bentoMuted },
  labelOn: { color: theme.bentoInk2 },
  value: { fontSize: 19, fontWeight: '800', letterSpacing: -0.4, color: theme.bentoInk, marginTop: 4 },
  valueOn: { color: theme.bentoInk },
  valueAlarm: { color: theme.bentoWarn },
  hint: { fontSize: 10.5, color: theme.bentoMuted2, marginTop: 3 },
  hintOn: { color: theme.bentoMuted },
});
