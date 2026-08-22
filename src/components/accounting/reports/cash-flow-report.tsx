import { useCallback, useEffect, useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { StatementSectionRows } from '@/components/accounting/reports/statement-section-card';
import type { DateRange } from '@/components/range-selector';
import { StatTile } from '@/components/stat-tile';
import { BentoCard } from '@/components/ui/bento-card';
import { Caveat } from '@/components/ui/caveat';
import { StatementRow } from '@/components/ui/statement-row';
import { Colors } from '@/constants/theme';
import { useAuth } from '@/hooks/use-auth';
import { useCaveatDismissal } from '@/hooks/use-caveat-dismissal';
import { fetchCashMovements } from '@/lib/cash-flow-data';
import { cashFlowStatement, type CashMovements } from '@/lib/financial-statements';
import { formatCompactCents } from '@/lib/currency';

const theme = Colors.light;

// Where the cash actually went.
//
// The statement a shop needs more than any other and gets least often, because
// profit and cash are not the same thing: a month can be profitable and still
// leave nothing in the till (stock bought, bills paid, an owner's draw), and it
// can be a loss and still fill the drawer (last month's debts collected).
//
// Every line here is money that moved, on a day, with a row behind it. Nothing
// is estimated — see lib/cash-flow-data.ts for why the direct method is the
// only honest one available here.

function extractErrorMessage(err: unknown): string {
  if (err && typeof err === 'object' && 'message' in err && typeof (err as { message: unknown }).message === 'string') {
    return (err as { message: string }).message;
  }
  return 'Something went wrong.';
}

export function CashFlowReport({
  dateRange,
  locationFilter,
  rangeLabel,
}: {
  dateRange: DateRange;
  locationFilter: string | null;
  rangeLabel: string;
}) {
  const { shop } = useAuth();
  const [movements, setMovements] = useState<CashMovements | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reconcileNote = useCaveatDismissal('reports-cash-flow-reconcile', 'v1');

  const { since, until } = dateRange;

  const reload = useCallback(async () => {
    if (!shop) return;
    try {
      setMovements(await fetchCashMovements({ shopId: shop.id, since, until, locationFilter }));
      setError(null);
    } catch (err) {
      setError(extractErrorMessage(err));
    } finally {
      setLoaded(true);
    }
  }, [shop, since, until, locationFilter]);

  useEffect(() => {
    reload();
  }, [reload]);

  const statement = useMemo(() => (movements ? cashFlowStatement(movements) : null), [movements]);

  if (!loaded || !statement) {
    return (
      <BentoCard title="Cash flow">
        <Text style={styles.empty}>{error ?? 'Loading…'}</Text>
      </BentoCard>
    );
  }

  const up = statement.netMovementCents >= 0;

  return (
    <>
      <BentoCard title="Did the shop end up with more money?" scope={rangeLabel}>
        <View style={styles.metricRow}>
          <StatTile
            variant="bento"
            value={`${up ? '+' : '−'}${formatCompactCents(Math.abs(statement.netMovementCents))}`}
            label={up ? 'More cash than it started with' : 'Less cash than it started with'}
            hint={`over ${rangeLabel.toLowerCase()}`}
          />
          <StatTile variant="bento" value={formatCompactCents(statement.operating.totalCents)} label="From trading" hint="takings less what trading cost" />
          <StatTile variant="bento" value={formatCompactCents(statement.cashHeldNowCents)} label="In hand right now" hint="tills, banks and wallets" />
        </View>
      </BentoCard>

      <BentoCard title="Cash flow" scope={rangeLabel}>
        {error ? <Text style={styles.error}>{error}</Text> : null}

        <Text style={styles.groupHeading}>TRADING</Text>
        {statement.operating.lines.length === 0 ? (
          <StatementRow label="No money moved in or out" amountCents={0} last />
        ) : (
          <StatementSectionRows section={statement.operating} />
        )}

        {statement.investing.lines.length > 0 && (
          <>
            <Text style={styles.groupHeading}>BUYING AND SELLING WHAT THE SHOP OWNS</Text>
            <StatementSectionRows section={statement.investing} />
          </>
        )}

        {statement.financing.lines.length > 0 && (
          <>
            <Text style={styles.groupHeading}>THE OWNER</Text>
            <StatementSectionRows section={statement.financing} />
          </>
        )}

        <StatementRow
          label={up ? 'Cash gained' : 'Cash lost'}
          hint={`over ${rangeLabel.toLowerCase()}`}
          amountCents={statement.netMovementCents}
          variant="total"
        />

        {!reconcileNote.dismissed ? (
          <Caveat tone="context" onDismiss={reconcileNote.dismiss}>
            Every line here is money that moved on a day, taken from payments, bill payments, pay runs and logged
            expenses. Moving money between your own accounts is absent on purpose — it changes where the cash sits,
            not how much there is. This will only match the change in your counted balances if every movement was
            recorded.
          </Caveat>
        ) : null}
      </BentoCard>
    </>
  );
}

const styles = StyleSheet.create({
  metricRow: { flexDirection: 'row', gap: 10, flexWrap: 'wrap' },
  groupHeading: { fontSize: 10.5, fontWeight: '900', letterSpacing: 1, color: theme.bentoMuted, marginTop: 18, marginBottom: 4 },
  empty: { color: theme.bentoMuted, fontSize: 13, textAlign: 'center', paddingVertical: 20 },
  error: { color: theme.bentoLoss, fontSize: 12, fontWeight: '700', marginBottom: 10 },
});
