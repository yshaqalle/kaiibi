import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { BENTO_RADIUS, Colors } from '@/constants/theme';
import { formatAccountingCents } from '@/lib/currency';

const theme = Colors.light;
const ON_INK_MUTED = '#a6a6ae';

export type TakingsMethod = { label: string; amountCents: number; group: 'cash' | 'mobile' | 'other' };

const FILTERS = [
  { label: 'All methods', matches: () => true },
  { label: 'Cash only', matches: (m: TakingsMethod) => m.group === 'cash' },
  { label: 'Mobile money', matches: (m: TakingsMethod) => m.group === 'mobile' },
] as const;

/**
 * The one dark card, and the question the Dashboard could never answer:
 * **how much money actually came through the till.**
 *
 * Takings is not revenue. The gap is sales tax, which was never the shop's
 * money — so a card headed "revenue" has always been quietly smaller than what
 * the drawer holds, and nothing on the screen said why.
 *
 * The money in / money out segment is where the reference design this came
 * from had a real bug: its filter changed the takings figure while the row
 * underneath stayed unfiltered, so "Mobile money" could show $0.00 sitting
 * directly above "Money out $1,000.00" — two numbers describing different
 * populations, with nothing saying so. Here a filter scopes the whole card or
 * it does not exist, and money OUT cannot be filtered at all (kaiibi does not
 * record which wallet an expense was paid from), so switching to it clears the
 * filter and says why.
 */
export function TakingsHeroCard({
  methods,
  revenueCents,
  expenseCents,
  taxCents,
  canSeeExpenses,
  onSeeProfitAndLoss,
}: {
  methods: TakingsMethod[];
  /** Net of tax and refunds — what the shop actually earned. */
  revenueCents: number;
  expenseCents: number;
  /** Collected on the authority's behalf. The gap between takings and revenue. */
  taxCents: number;
  canSeeExpenses: boolean;
  onSeeProfitAndLoss: () => void;
}) {
  const [flow, setFlow] = useState<'in' | 'out'>('in');
  const [filterIndex, setFilterIndex] = useState(0);

  const showingOut = flow === 'out';
  const filter = FILTERS[filterIndex];
  const filtered = methods.filter(filter.matches);
  const takingsCents = filtered.reduce((sum, m) => sum + m.amountCents, 0);
  const allTakingsCents = methods.reduce((sum, m) => sum + m.amountCents, 0);

  // Revenue attributable to the selected methods: takings less this shop's tax,
  // held in proportion. Only meaningful for money IN.
  const filteredRevenueCents =
    allTakingsCents > 0 ? Math.round(revenueCents * (takingsCents / allTakingsCents)) : revenueCents;
  const isFiltered = filterIndex !== 0;

  function switchTo(next: 'in' | 'out') {
    if (next === flow) return;
    // Leaving money-in with a filter on would strand a filter that cannot
    // apply to what is now on screen.
    if (next === 'out') setFilterIndex(0);
    setFlow(next);
  }

  return (
    <View style={styles.card}>
      <View style={styles.head}>
        <Text style={styles.eyebrow}>Takings</Text>
        {/* Hidden entirely in money-out, rather than shown and ignored. */}
        {!showingOut ? (
          <Pressable
            onPress={() => setFilterIndex((index) => (index + 1) % FILTERS.length)}
            style={({ pressed }) => [styles.pill, pressed && styles.pillPressed]}
            role="button"
          >
            <Text style={styles.pillLabel}>{filter.label}</Text>
            <Text style={styles.caret}>▾</Text>
          </Pressable>
        ) : null}
      </View>

      <Text style={styles.label}>Gross takings this period</Text>
      <Text style={styles.big}>{formatAccountingCents(takingsCents)}</Text>

      {canSeeExpenses ? (
        <View style={styles.segment}>
          {(['in', 'out'] as const).map((key) => {
            const active = flow === key;
            return (
              <Pressable
                key={key}
                onPress={() => switchTo(key)}
                style={[styles.segButton, active && styles.segButtonOn]}
                role="tab"
                aria-selected={active}
              >
                <Text style={[styles.segLabel, active && styles.segLabelOn]}>
                  {key === 'in' ? 'Money in' : 'Money out'}
                </Text>
              </Pressable>
            );
          })}
        </View>
      ) : null}

      <View style={styles.rule} />

      <View style={styles.flowRow}>
        <View style={styles.flowText}>
          <Text style={styles.label}>{showingOut ? 'Money out this period' : 'Revenue, net of tax'}</Text>
          <Text style={[styles.flowValue, showingOut && styles.flowValueOut]}>
            {showingOut
              ? `−${formatAccountingCents(expenseCents)}`
              : formatAccountingCents(isFiltered ? filteredRevenueCents : revenueCents)}
          </Text>
        </View>
        <Pressable onPress={onSeeProfitAndLoss} style={styles.link} role="button">
          <Text style={styles.linkText}>See full profit &amp; loss →</Text>
        </Pressable>
      </View>

      <Text style={styles.scopeNote}>
        {showingOut
          ? 'Money out is operating expenses, which carry no payment method — so the methods filter is off and the takings above are all methods.'
          : isFiltered
            ? `Showing ${filtered.length} of ${methods.length} methods. Both figures above are filtered.`
            : `${formatAccountingCents(taxCents)} of this is sales tax you are holding for the authority, which is why takings exceed revenue.`}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: BENTO_RADIUS,
    backgroundColor: theme.bentoInk,
    padding: 18,
  },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, minHeight: 30 },
  eyebrow: { fontSize: 11, fontWeight: '800', letterSpacing: 1.2, textTransform: 'uppercase', color: '#c7c7cf' },
  label: { fontSize: 12, color: ON_INK_MUTED, marginTop: 14 },
  big: {
    fontSize: 34,
    fontWeight: '800',
    letterSpacing: -1,
    color: '#ffffff',
    marginTop: 4,
    fontVariant: ['tabular-nums'],
  },
  segment: { flexDirection: 'row', gap: 8, marginTop: 16 },
  segButton: {
    flex: 1,
    alignItems: 'center',
    borderRadius: 999,
    paddingVertical: 9,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.2)',
    overflow: 'hidden',
  },
  segButtonOn: { backgroundColor: '#ffffff', borderColor: '#ffffff' },
  segLabel: { fontSize: 12.5, fontWeight: '700', color: '#ffffff' },
  segLabelOn: { color: theme.bentoInk },
  rule: { borderTopWidth: 1, borderTopColor: 'rgba(255,255,255,0.16)', marginTop: 16, marginBottom: 12 },
  flowRow: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' },
  flowText: { flexGrow: 1, flexShrink: 1, flexBasis: 120 },
  flowValue: { fontSize: 18, fontWeight: '800', color: '#ffffff', marginTop: 2, fontVariant: ['tabular-nums'] },
  // The minus sign in the value is what says "out"; this only reinforces it.
  flowValueOut: { color: Colors.dark.bentoLoss },
  link: { paddingVertical: 4 },
  linkText: { fontSize: 11.5, fontWeight: '700', color: '#ffffff' },
  scopeNote: { fontSize: 10.5, color: ON_INK_MUTED, marginTop: 10, lineHeight: 15 },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.18)',
    backgroundColor: 'rgba(255,255,255,0.09)',
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 5,
    overflow: 'hidden',
  },
  pillPressed: { backgroundColor: 'rgba(255,255,255,0.2)' },
  pillLabel: { fontSize: 11.5, fontWeight: '700', color: '#ffffff' },
  caret: { fontSize: 9, color: ON_INK_MUTED },
});
