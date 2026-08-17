import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Svg, { Defs, RadialGradient, Rect, Stop } from 'react-native-svg';

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
  refundedCents = 0,
  canSeeExpenses,
  onSeeProfitAndLoss,
}: {
  methods: TakingsMethod[];
  /** Net of tax and refunds — what the shop actually earned. */
  revenueCents: number;
  expenseCents: number;
  /** Collected on the authority's behalf. The gap between takings and revenue. */
  taxCents: number;
  /**
   * Refunds in the range. Part of the gap between takings and revenue, and
   * usually the bigger part — a note naming only the tax leaves a reader's
   * subtraction not working.
   */
  refundedCents?: number;
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
      {/* The design's two radial washes: a bare lift from the top-left and a
          teal one from the bottom-right. On a card this size flat ink reads as
          a hole punched in the page rather than as a surface. Decorative only,
          and behind everything. */}
      <View style={styles.wash} pointerEvents="none">
        <Svg width="100%" height="100%">
          <Defs>
            <RadialGradient id="heroLift" cx="0%" cy="0%" r="110%">
              <Stop offset="0" stopColor="#ffffff" stopOpacity={0.07} />
              <Stop offset="0.55" stopColor="#ffffff" stopOpacity={0} />
            </RadialGradient>
            <RadialGradient id="heroTeal" cx="100%" cy="118%" r="115%">
              <Stop offset="0" stopColor={theme.bentoSeries2} stopOpacity={0.22} />
              <Stop offset="0.62" stopColor={theme.bentoSeries2} stopOpacity={0} />
            </RadialGradient>
          </Defs>
          <Rect x="0" y="0" width="100%" height="100%" fill="url(#heroTeal)" />
          <Rect x="0" y="0" width="100%" height="100%" fill="url(#heroLift)" />
        </Svg>
      </View>
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
            : refundedCents > 0
              ? `Takings run ahead of revenue by ${formatAccountingCents(taxCents)} of sales tax you are holding for the authority and ${formatAccountingCents(refundedCents)} refunded to customers.`
              : `${formatAccountingCents(taxCents)} of this is sales tax you are holding for the authority, which is why takings exceed revenue.`}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  // `flexGrow: 1` so the card fills the height its cell was stretched to.
  // Without it the card sized to its own content and stopped short of the
  // white one beside it — the Overview row read as five cards of five
  // different heights rather than as one band, which is the whole reason the
  // grid stretches.
  //
  // Not `flex: 1`: RN's shorthand also sets `flexBasis: 0`, so the card would
  // contribute NO height to its cell and collapse to nothing on a phone, where
  // one card per row means the stretch has no taller sibling to stretch to.
  card: {
    flexGrow: 1,
    borderRadius: BENTO_RADIUS,
    backgroundColor: theme.bentoInk,
    padding: 18,
    overflow: 'hidden',
  },
  wash: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 },
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
  // `marginTop: auto` takes up whatever height the stretch handed the card and
  // puts it ABOVE this block, so the bottom line sits on the bottom edge
  // instead of floating directly under the rule with dead space beneath it.
  flowRow: {
    marginTop: 'auto',
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    gap: 12,
    flexWrap: 'wrap',
  },
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
