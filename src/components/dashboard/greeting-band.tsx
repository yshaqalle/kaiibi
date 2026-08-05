import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Colors } from '@/constants/theme';
import { formatAccountingCents } from '@/lib/currency';

const theme = Colors.light;

// The plain-language line above the numbers: "here is how the business is
// doing, in a sentence."
//
// Written from figures the Dashboard already holds, so it can never disagree
// with the cards below it -- which is the whole reason it is computed here
// rather than typed as copy. A loss is stated AS a loss, in those words,
// because "net profit -$593.50" is a thing an owner has to decode.

export function summarySentence({
  netProfitCents,
  revenueCents,
  operatingExpenseCents: expensesCents,
  uncostedItemCount,
}: {
  netProfitCents: number;
  revenueCents: number;
  operatingExpenseCents: number;
  uncostedItemCount: number;
}): string {
  const parts: string[] = [];

  if (revenueCents === 0) {
    parts.push('No sales recorded for this period yet.');
  } else if (netProfitCents < 0) {
    parts.push(
      `You're running at a loss of ${formatAccountingCents(Math.abs(netProfitCents))} this period — expenses of ${formatAccountingCents(expensesCents)} are outpacing ${formatAccountingCents(revenueCents)} of revenue.`
    );
  } else {
    parts.push(
      `Net profit is ${formatAccountingCents(netProfitCents)} this period on ${formatAccountingCents(revenueCents)} of revenue.`
    );
  }

  // Said here as well as on the caveat below, because a summary that reads
  // "net profit is $544.60" without it is quietly overstating the figure it
  // just led with.
  if (uncostedItemCount > 0) {
    parts.push(
      `${uncostedItemCount} sold ${uncostedItemCount === 1 ? 'item still has' : 'items still have'} no cost recorded.`
    );
  }

  return parts.join(' ');
}

function greetingFor(hour: number): string {
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

export function GreetingBand({
  summary,
  attentionCount,
  onShowTasks,
}: {
  summary: string;
  attentionCount: number;
  onShowTasks: () => void;
}) {
  const now = new Date();

  return (
    <View style={styles.band}>
      <View style={styles.dateChip}>
        <Text style={styles.dateNum}>{now.getDate()}</Text>
        <Text style={styles.dateMeta}>
          {now.toLocaleDateString(undefined, { weekday: 'short' })},{'\n'}
          {now.toLocaleDateString(undefined, { month: 'long' })}
        </Text>
      </View>

      <View style={styles.text}>
        <Text style={styles.greeting}>{greetingFor(now.getHours())}</Text>
        <Text style={styles.summary}>{summary}</Text>
      </View>

      {attentionCount > 0 ? (
        <Pressable onPress={onShowTasks} style={styles.cta} accessibilityRole="button">
          <Text style={styles.ctaText}>
            {/* The count is on the button rather than beside it: "Show my
                tasks" alone gives no reason to press, and the number is the
                reason. */}
            Show my tasks · {attentionCount}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  band: { flexDirection: 'row', alignItems: 'center', gap: 16, flexWrap: 'wrap', marginBottom: 18 },
  dateChip: {
    width: 78,
    height: 78,
    borderRadius: 39,
    borderWidth: 1,
    borderColor: theme.bentoLine,
    backgroundColor: theme.bentoSurface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dateNum: { fontSize: 24, fontWeight: '800', color: theme.bentoInk, lineHeight: 26 },
  dateMeta: { fontSize: 10.5, color: theme.bentoMuted, textAlign: 'center', marginTop: 2, lineHeight: 13 },
  text: { flex: 1, minWidth: 220 },
  greeting: { fontSize: 24, fontWeight: '800', letterSpacing: -0.5, color: theme.bentoInk },
  summary: { fontSize: 14, color: theme.bentoMuted, marginTop: 3, lineHeight: 20 },
  cta: {
    backgroundColor: theme.bentoInk,
    borderRadius: 999,
    paddingVertical: 13,
    paddingHorizontal: 22,
  },
  ctaText: { color: '#FFFFFF', fontSize: 14, fontWeight: '700' },
});
