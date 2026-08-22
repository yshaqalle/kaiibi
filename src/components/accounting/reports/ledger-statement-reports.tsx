import { useCallback, useEffect, useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { StatementSectionRows } from '@/components/accounting/reports/statement-section-card';
import { StatTile } from '@/components/stat-tile';
import { BentoCard } from '@/components/ui/bento-card';
import { Caveat } from '@/components/ui/caveat';
import { StatementRow } from '@/components/ui/statement-row';
import { Colors } from '@/constants/theme';
import { useAuth } from '@/hooks/use-auth';
import { useCaveatDismissal } from '@/hooks/use-caveat-dismissal';
import { balanceSheet, incomeStatement } from '@/lib/financial-statements';
import { formatAccountingCents, formatCompactCents } from '@/lib/currency';
import { listLedgerAccounts, ledgerAccountMovement } from '@/lib/ledger';
import { fetchLedgerSnapshot } from '@/lib/ledger-feeds';
import { accountBalances, type AccountBalance } from '@/lib/trial-balance';
import type { DateRange } from '@/components/range-selector';

const theme = Colors.light;

// The income statement and the balance sheet, both drawn from the chart of
// accounts.
//
// They share this file and one fetch because they share their input: the same
// set of account balances, arranged two ways. Two components each pulling the
// whole ledger would be two heavy fetches and, worse, two chances for the two
// statements to disagree about the same period.

function extractErrorMessage(err: unknown): string {
  if (err && typeof err === 'object' && 'message' in err && typeof (err as { message: unknown }).message === 'string') {
    return (err as { message: string }).message;
  }
  return 'Something went wrong.';
}

/** The fetch both statements sit on. Shared so they cannot drift. */
function useLedgerBalances(dateRange: DateRange, locationFilter: string | null) {
  const { shop } = useAuth();
  const [balances, setBalances] = useState<AccountBalance[]>([]);
  const [asOf, setAsOf] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { since, until } = dateRange;

  const reload = useCallback(async () => {
    if (!shop) return;
    try {
      const [accounts, snapshot, movement] = await Promise.all([
        listLedgerAccounts(shop.id),
        fetchLedgerSnapshot({ shopId: shop.id, since, until, locationFilter }),
        // All time, not the range: a posted account carries its opening figure
        // plus everything ever posted to it. See TrialBalanceView, which makes
        // the same call for the same reason.
        ledgerAccountMovement(shop.id),
      ]);
      setBalances(accountBalances(accounts, snapshot.feeds, movement));
      setAsOf(snapshot.asOf);
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

  return { balances, asOf, loaded, error, reload };
}

export function IncomeStatementReport({
  dateRange,
  locationFilter,
  rangeLabel,
  /**
   * The same document under two names, and the picker offers both because both
   * are what a reader went looking for. It is deliberately ONE report: two
   * would be two profit figures for one period, which is exactly the drift
   * lib/pnl.ts exists to prevent.
   */
  title,
}: {
  dateRange: DateRange;
  locationFilter: string | null;
  rangeLabel: string;
  title: string;
}) {
  const { balances, loaded, error } = useLedgerBalances(dateRange, locationFilter);
  const statement = useMemo(() => incomeStatement(balances), [balances]);
  const depreciationNote = useCaveatDismissal('reports-income-depreciation', 'v1');

  // Only worth explaining when there is some. On a shop with no asset register
  // this statement and the Overview's profit figure agree exactly.
  const depreciationCents = statement.operatingExpenses.lines
    .filter((line) => line.label.toLowerCase().includes('depreciation'))
    .reduce((sum, line) => sum + line.amountCents, 0);

  if (!loaded) return <BentoCard title={title}><Text style={styles.empty}>Loading…</Text></BentoCard>;

  return (
    <>
      <BentoCard title="The bottom line" scope={rangeLabel}>
        <View style={styles.metricRow}>
          <StatTile variant="bento" value={formatCompactCents(statement.revenue.totalCents)} label="Revenue" hint="net of tax and refunds" />
          <StatTile variant="bento" value={formatCompactCents(statement.grossProfitCents)} label="Gross profit" hint={statement.grossMarginPct === null ? undefined : `${statement.grossMarginPct}% margin`} />
          <StatTile variant="bento" value={formatCompactCents(statement.netProfitCents)} label="Net profit" hint={statement.netMarginPct === null ? undefined : `${statement.netMarginPct}% of revenue`} />
        </View>
      </BentoCard>

      <BentoCard title={title} scope={rangeLabel}>
        {error ? <Text style={styles.error}>{error}</Text> : null}

        <StatementSectionRows section={statement.revenue} showTotal={statement.revenue.lines.length > 1} />
        <StatementSectionRows section={statement.costOfSales} showTotal={statement.costOfSales.lines.length > 1} />
        <StatementRow label="Gross profit" hint="what is left after what the goods cost" amountCents={statement.grossProfitCents} variant="emphasis" last />

        <StatementSectionRows section={statement.operatingExpenses} />
        <StatementRow label="Operating profit" amountCents={statement.operatingProfitCents} variant="emphasis" last />

        <StatementSectionRows section={statement.otherIncome} showTotal={statement.otherIncome.lines.length > 1} />
        <StatementSectionRows section={statement.otherExpenses} showTotal={statement.otherExpenses.lines.length > 1} />

        <StatementRow label="Net profit" amountCents={statement.netProfitCents} variant="total" />

        {depreciationCents > 0 && !depreciationNote.dismissed ? (
          <Caveat tone="context" onDismiss={depreciationNote.dismiss}>
            {`This includes ${formatAccountingCents(depreciationCents)} of depreciation — the wear on the asset register, spread over each asset's life. No money left the shop for it, which is why the Dashboard's profit figure, built from cash costs, is higher.`}
          </Caveat>
        ) : null}
      </BentoCard>
    </>
  );
}

export function BalanceSheetReport({
  dateRange,
  locationFilter,
  rangeLabel,
}: {
  dateRange: DateRange;
  locationFilter: string | null;
  rangeLabel: string;
}) {
  const { balances, asOf, loaded, error } = useLedgerBalances(dateRange, locationFilter);
  const sheet = useMemo(() => balanceSheet(balances), [balances]);
  const asOfNote = useCaveatDismissal('reports-balance-sheet-as-of', 'v1');

  if (!loaded) return <BentoCard title="Balance sheet"><Text style={styles.empty}>Loading…</Text></BentoCard>;

  return (
    <>
      <BentoCard title="What the business is worth" scope="As of today">
        <View style={styles.metricRow}>
          <StatTile variant="bento" value={formatCompactCents(sheet.totalAssetsCents)} label="Owns" hint="cash, stock, debts owed in, assets" />
          <StatTile variant="bento" value={formatCompactCents(sheet.totalLiabilitiesCents)} label="Owes" hint="suppliers, tax, loans" />
          <StatTile variant="bento" value={formatCompactCents(sheet.totalEquityCents)} label="Left over" hint="the owner's stake" />
        </View>
      </BentoCard>

      <BentoCard title="Balance sheet" scope={asOf ? `As of ${asOf}` : 'As of today'}>
        {error ? <Text style={styles.error}>{error}</Text> : null}

        <Text style={styles.groupHeading}>WHAT THE SHOP OWNS</Text>
        <StatementSectionRows section={sheet.currentAssets} />
        <StatementSectionRows section={sheet.fixedAssets} />
        <StatementSectionRows section={sheet.otherAssets} />
        <StatementRow label="Total assets" amountCents={sheet.totalAssetsCents} variant="emphasis" last />

        <Text style={styles.groupHeading}>WHAT IT OWES</Text>
        {sheet.currentLiabilities.lines.length === 0 && sheet.longTermLiabilities.lines.length === 0 ? (
          <StatementRow label="Nothing outstanding" amountCents={0} last />
        ) : (
          <>
            <StatementSectionRows section={sheet.currentLiabilities} />
            <StatementSectionRows section={sheet.longTermLiabilities} />
          </>
        )}
        <StatementRow label="Total liabilities" amountCents={sheet.totalLiabilitiesCents} variant="emphasis" last />

        <Text style={styles.groupHeading}>THE OWNER&apos;S STAKE</Text>
        <StatementSectionRows section={sheet.postedEquity} showTotal={sheet.postedEquity.lines.length > 1} />
        <StatementRow
          label="Retained earnings"
          hint={`profit kept in the business over ${rangeLabel.toLowerCase()}`}
          amountCents={sheet.retainedEarningsCents}
        />
        <StatementRow label="Total equity" amountCents={sheet.totalEquityCents} variant="emphasis" last />

        <StatementRow
          label="Owes and owner's stake together"
          hint="should equal what the shop owns"
          amountCents={sheet.totalLiabilitiesCents + sheet.totalEquityCents}
          variant="total"
        />

        {!sheet.balanced ? (
          // `wrong`, and the action is the fix: this sheet is not describing
          // the business until the gap closes, and the gap has one usual cause.
          <Caveat tone="wrong">
            {`This does not balance — ${formatAccountingCents(Math.abs(sheet.differenceCents))} is unaccounted for. That is almost always an opening balance nobody has entered: what the owner put in, and any profit kept from before these books started. Add it to Owner's equity or Retained earnings in Ledger → Chart of accounts and this closes.`}
          </Caveat>
        ) : null}

        {!asOfNote.dismissed ? (
          <Caveat tone="context" onDismiss={asOfNote.dismiss}>
            Assets and debts are shown as they stand today, whatever range is picked — a cash account holds one
            confirmed balance and stock holds one count, so there is no history to draw an earlier snapshot from.
            Only retained earnings follows the range.
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
