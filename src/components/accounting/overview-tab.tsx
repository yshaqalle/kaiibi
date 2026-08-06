import { useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { formatRangeLabel } from '@/components/accounting/transactions-tab';
import { useHeaderActions, type HeaderActionsSetter } from '@/components/accounting/use-header-actions';
import { ExportMenu } from '@/components/export-menu';
import { BentoCell, BentoGrid } from '@/components/ui/bento';
import { BentoCard } from '@/components/ui/bento-card';
import { PaymentMixChart, type PaymentMixItem } from '@/components/payment-mix-chart';
import type { DateRange } from '@/components/range-selector';
import { RankingChart, type RankingItem } from '@/components/ranking-chart';
import { StatTile } from '@/components/stat-tile';
import { TrendChart, type TrendPoint } from '@/components/trend-chart';
import { Caveat } from '@/components/ui/caveat';
import { Colors } from '@/constants/theme';
import { useAuth } from '@/hooks/use-auth';
import { useCaveatDismissal } from '@/hooks/use-caveat-dismissal';
import { formatAccountingCents, formatCompactCents } from '@/lib/currency';
import { totalExpenseCents } from '@/lib/expense-reporting';
import { listExpensesInRange } from '@/lib/expenses';
import { scopeToLocation } from '@/lib/location-reporting';
import { getSalesAndRefundsInRange, getTopSellingProducts } from '@/lib/sales';
import {
  bucketDailyTotals,
  cashierPerformance,
  costOfGoodsSold,
  paymentMethodMix,
  type DailyBucket,
} from '@/lib/sales-reporting';

// Pinned to the light palette for now — no dark-mode switching yet.
const theme = Colors.light;

const OVERVIEW_EXPORT_COLUMNS = [
  { header: 'Day', value: (d: DailyBucket) => d.day },
  { header: 'Gross', value: (d: DailyBucket) => (d.grossCents / 100).toFixed(2) },
  { header: 'Sales tax', value: (d: DailyBucket) => (d.taxCents / 100).toFixed(2) },
  { header: 'Refunds', value: (d: DailyBucket) => (d.refundCents / 100).toFixed(2) },
  { header: 'Revenue', value: (d: DailyBucket) => (d.netRevenueCents / 100).toFixed(2) },
  { header: 'Discounts', value: (d: DailyBucket) => (d.discountCents / 100).toFixed(2) },
  { header: 'Orders', value: (d: DailyBucket) => String(d.orderCount) },
];

function extractErrorMessage(err: unknown): string {
  if (err && typeof err === 'object' && 'message' in err && typeof (err as { message: unknown }).message === 'string') {
    return (err as { message: string }).message;
  }
  return 'Something went wrong.';
}

export function OverviewTab({
  dateRange,
  locationFilter,
  setHeaderActions,
}: {
  dateRange: DateRange;
  /** Owned by the Accounting shell so it survives a tab switch. null = every store. */
  locationFilter: string | null;
  setHeaderActions: HeaderActionsSetter;
}) {
  const { shop } = useAuth();
  const router = useRouter();
  // The local `wide = width >= 1000` check is gone: BentoGrid owns the
  // breakpoints now, so this tab no longer has an opinion about them that
  // could drift from the one the rest of the screen uses.
  const { since, until } = dateRange;

  const [daily, setDaily] = useState<DailyBucket[]>([]);
  const [expenseCents, setExpenseCents] = useState(0);
  const [paymentMix, setPaymentMix] = useState<PaymentMixItem[]>([]);
  const [topProducts, setTopProducts] = useState<{ name: string; revenueCents: number }[]>([]);
  const [cashiers, setCashiers] = useState<{ name: string; revenueCents: number }[]>([]);
  const [cogsCents, setCogsCents] = useState(0);
  const [uncostedItemCount, setUncostedItemCount] = useState(0);
  const [uncostedRevenueCents, setUncostedRevenueCents] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!shop) return;
    setLoading(true);
    try {
      // The daily buckets, the payment mix, the cashier ranking and now the
      // cost of goods are all derived from the SAME sales set, which is
      // already fetched once here. Cost of goods is therefore free — which is
      // why the profit figure below can be a real one rather than a
      // simplification.
      const [{ sales, refunds }, expenses, top] = await Promise.all([
        getSalesAndRefundsInRange(shop.id, since, until, locationFilter),
        listExpensesInRange(shop.id, since, until),
        getTopSellingProducts(shop.id, since, until),
      ]);
      setDaily(bucketDailyTotals(sales, refunds, since, until));
      setExpenseCents(totalExpenseCents(scopeToLocation(expenses, locationFilter)));
      setPaymentMix(paymentMethodMix(sales));
      setTopProducts(top.byRevenue);
      setCashiers(cashierPerformance(sales));
      const cogs = costOfGoodsSold(sales, refunds);
      setCogsCents(cogs.cogsCents);
      setUncostedItemCount(cogs.uncostedItemCount);
      setUncostedRevenueCents(cogs.uncostedRevenueCents);
      setError(null);
    } catch (err) {
      setError(extractErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [shop, since, until, locationFilter]);

  useEffect(() => { reload(); }, [reload]);

  const revenueCents = useMemo(() => daily.reduce((sum, d) => sum + d.netRevenueCents, 0), [daily]);
  const refundCents = useMemo(() => daily.reduce((sum, d) => sum + d.refundCents, 0), [daily]);
  const taxCents = useMemo(() => daily.reduce((sum, d) => sum + d.taxCents, 0), [daily]);

  // Revenue less what the goods cost. NOT net profit: operating expenses and
  // labour come off on Reports.
  //
  // This tile used to read "Net profit" and be `revenue - expenses`, with no
  // cost of goods in it at all — so Overview and Reports each showed a figure
  // called "Net profit" and they could differ by an order of magnitude, with
  // nothing on either screen to explain why. The data to do it properly was
  // already being fetched.
  const grossProfitCents = revenueCents - cogsCents;

  // Null rather than 0 when there is no revenue: "0% margin" on a quiet day
  // states something false about the shop, where no figure states nothing.
  //
  // Null ALSO when nothing sold has a cost recorded. The arithmetic then says
  // 100% margin, which is technically what revenue-minus-zero gives and is a
  // flatly misleading thing to print next to a figure we already know is
  // overstated. A shop that has never entered a cost price should be told it
  // has no margin figure, not handed a perfect one.
  const noCostsRecorded = cogsCents === 0 && uncostedItemCount > 0;
  const marginPct =
    revenueCents > 0 && !noCostsRecorded ? Math.round((grossProfitCents / revenueCents) * 100) : null;

  const trendData: TrendPoint[] = useMemo(
    () =>
      daily.map((d) => ({
        // Not [0]: a column of M/T/W/T/F/S/S is ambiguous twice over, and
        // TrendChart only draws labels at 10 points or fewer, so the short
        // name always fits.
        label: new Date(d.day).toLocaleDateString(undefined, { weekday: 'short' }),
        value: d.netRevenueCents,
      })),
    [daily]
  );

  const rankItems: RankingItem[] = useMemo(
    () => topProducts.map((p) => ({ name: p.name, value: p.revenueCents })),
    [topProducts]
  );

  const cashierItems: RankingItem[] = useMemo(
    () => cashiers.map((c) => ({ name: c.name, value: c.revenueCents })),
    [cashiers]
  );

  const rangeLabel = formatRangeLabel(dateRange);

  // The two explainers are the same sentence every time, so closing one closes
  // it for good. The uncosted-cost note is keyed to the shortfall it describes:
  // let more items sell without a cost price and it is a different, larger
  // problem, so it comes back rather than staying hidden.
  const revenueNote = useCaveatDismissal('accounting.overview.revenue-vs-tax', 'v1');
  const grossProfitNote = useCaveatDismissal('accounting.overview.gross-profit-scope', 'v1');
  const uncostedNote = useCaveatDismissal(
    'accounting.overview.uncosted-cogs',
    `${uncostedItemCount}:${uncostedRevenueCents}`
  );
  const cashierNote = useCaveatDismissal('accounting.overview.cashier-gross-takings', 'v1');
  const showUncostedNote = uncostedItemCount > 0 && !uncostedNote.dismissed;
  const showAnyCaveat = !revenueNote.dismissed || !grossProfitNote.dismissed || showUncostedNote;

  // The daily figures rather than the raw sales: this tab is a summary, so its
  // export is the summary. Someone wanting every line has Transactions.
  useHeaderActions(
    setHeaderActions,
    <ExportMenu
      rows={daily}
      columns={OVERVIEW_EXPORT_COLUMNS}
      title="Accounting overview"
      subtitle={rangeLabel}
      filenamePrefix="overview"
    />,
    [daily, rangeLabel]
  );

  if (loading) {
    return (
      <BentoGrid>
        <BentoCell span={12}>
          <BentoCard>
            <Text style={styles.empty}>Loading…</Text>
          </BentoCard>
        </BentoCell>
      </BentoGrid>
    );
  }

  return (
    <BentoGrid>
      {error ? (
        <BentoCell span={12}>
          <Text style={styles.error}>{error}</Text>
        </BentoCell>
      ) : null}

      <BentoCell span={12}>
        <BentoCard title="This period at a glance" scope={rangeLabel}>
          <View style={styles.metricRow}>
            <StatTile variant="bento" value={formatCompactCents(revenueCents)} label="Revenue" hint="net of sales tax & refunds" />
            <StatTile variant="bento" value={formatCompactCents(expenseCents)} label="Expenses" hint="operating" />
            <StatTile variant="bento"
              value={formatCompactCents(grossProfitCents)}
              label="Gross profit"
              hint={
                marginPct !== null
                  ? `${marginPct}% margin · before expenses`
                  : noCostsRecorded
                    ? 'no cost prices recorded'
                    : 'before operating expenses'
              }
              tone={noCostsRecorded ? 'default' : 'positive'}
            />
            <StatTile variant="bento" value={formatCompactCents(taxCents)} label="Sales tax collected" hint="held for the tax authority" />
          </View>
        </BentoCard>
      </BentoCell>

      {/* Kept outside a card: these explain the figures above rather than
          being a figure of their own, and boxing each one turned three
          sentences into three competing panels.

          The cell goes with them once all three are closed — an empty
          BentoCell still spends a row gap, leaving a hole where the reader
          just tidied up. */}
      {showAnyCaveat ? (
        <BentoCell span={12}>
          {revenueNote.dismissed ? null : (
            <Caveat tone="context" onDismiss={revenueNote.dismiss}>
              {`Revenue is what you earned — sales tax collected is held for the tax authority and is not counted as income.${
                refundCents > 0 ? ` ${formatAccountingCents(refundCents)} of refunds is already deducted.` : ''
              }`}
            </Caveat>
          )}
          {grossProfitNote.dismissed ? null : (
            <Caveat tone="context" onDismiss={grossProfitNote.dismiss}>
              Gross profit is revenue less what the goods cost. Operating expenses and wages come off on Reports, which
              is where the bottom line lives.
            </Caveat>
          )}
          {showUncostedNote ? (
            <Caveat
              tone="wrong"
              action={{
                label: 'Set costs in Inventory',
                onPress: () => router.push({ pathname: '/inventory', params: { filter: 'nocost' } }),
              }}
              onDismiss={uncostedNote.dismiss}
            >
              {`${uncostedItemCount} sold ${uncostedItemCount === 1 ? 'item has' : 'items have'} no cost recorded (${formatAccountingCents(uncostedRevenueCents)} of revenue), so cost of goods is understated and gross profit looks higher than it is.`}
            </Caveat>
          ) : null}
        </BentoCell>
      ) : null}

      {/* Paired so the revenue shape and the payment split are read together —
          they answer "how much" and "how" about the same money. The grid
          stacks them below its own breakpoints, which is why this no longer
          needs the local `wide` check it used to carry. */}
      <BentoCell span={7}>
        <BentoCard title="Revenue" scope={rangeLabel}>
          <TrendChart data={trendData} formatValue={formatCompactCents} showAxis />
        </BentoCard>
      </BentoCell>

      <BentoCell span={5}>
        <BentoCard title="Payment methods" scope={rangeLabel}>
          <PaymentMixChart items={paymentMix} formatValue={formatAccountingCents} />
        </BentoCard>
      </BentoCell>

      <BentoCell span={6}>
        <BentoCard title="Top products" scope={rangeLabel}>
          <RankingChart
            items={rankItems}
            formatValue={formatAccountingCents}
            emptyLabel="No sales yet in this range."
            showRank
          />
        </BentoCard>
      </BentoCell>

      {/* Moved here from Reports: who served the most is a pulse question,
          not an analysis one, and it comes free from the sales set already
          loaded above. */}
      <BentoCell span={6}>
        <BentoCard title="Who rang it up" scope={rangeLabel}>
          <RankingChart
            items={cashierItems}
            formatValue={formatAccountingCents}
            emptyLabel="No cashier activity in this range."
            showRank
          />
          {cashierNote.dismissed ? null : (
            <Caveat tone="context" onDismiss={cashierNote.dismiss}>
              Gross takings, not net — this ranks who served the most, so it reconciles against a till.
            </Caveat>
          )}
        </BentoCard>
      </BentoCell>
    </BentoGrid>
  );
}

const styles = StyleSheet.create({
  metricRow: { flexDirection: 'row', gap: 10, flexWrap: 'wrap' },
  empty: { color: theme.bentoMuted, fontSize: 13, marginTop: 20, textAlign: 'center' },
  error: { color: theme.bentoLoss, fontSize: 12, fontWeight: '700' },
});
