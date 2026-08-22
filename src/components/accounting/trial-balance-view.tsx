import { useCallback, useEffect, useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { useHeaderActions, type HeaderActionsSetter } from '@/components/accounting/use-header-actions';
import { ExportMenu } from '@/components/export-menu';
import type { DateRange } from '@/components/range-selector';
import { StatTile } from '@/components/stat-tile';
import { BentoCard } from '@/components/ui/bento-card';
import { Caveat } from '@/components/ui/caveat';
import { DataTable, NameCell, ValueCell, type Column } from '@/components/ui/data-table';
import { Colors } from '@/constants/theme';
import { useAuth } from '@/hooks/use-auth';
import { accountTypeLabel } from '@/lib/chart-of-accounts';
import type { CsvColumn } from '@/lib/csv';
import { formatAccountingCents, formatCompactCents } from '@/lib/currency';
import { fetchLedgerSnapshot } from '@/lib/ledger-feeds';
import { ledgerAccountMovement } from '@/lib/ledger';
import { trialBalance, type AccountBalance, type AccountMovement, type FeedFigures } from '@/lib/trial-balance';
import type { LedgerAccount } from '@/types/models';

const theme = Colors.light;

// The trial balance: every account with its balance in the column it belongs
// in, and the two columns' totals side by side.
//
// The screen exists for exactly one moment -- the one where the two totals do
// not match -- so the difference is the loudest thing on it, and it comes with
// the explanation. In a hand-kept ledger a difference means an arithmetic
// mistake; here it almost always means the shop has not yet said what it
// started with. Those need completely different reactions, and a reader hunting
// for a slip that is not there will not find one.

const EXPORT_COLUMNS: CsvColumn<AccountBalance>[] = [
  { header: 'Code', value: (r) => r.account.code },
  { header: 'Account', value: (r) => r.account.name },
  { header: 'Type', value: (r) => accountTypeLabel(r.account.type) },
  { header: 'Source', value: (r) => (r.basis === 'feed' ? 'Reported' : 'Posted') },
  { header: 'Debit', value: (r) => (r.debitCents ? (r.debitCents / 100).toFixed(2) : '') },
  { header: 'Credit', value: (r) => (r.creditCents ? (r.creditCents / 100).toFixed(2) : '') },
];

function extractErrorMessage(err: unknown): string {
  if (err && typeof err === 'object' && 'message' in err && typeof (err as { message: unknown }).message === 'string') {
    return (err as { message: string }).message;
  }
  return 'Something went wrong.';
}

export function TrialBalanceView({
  accounts,
  dateRange,
  locationFilter,
  revision,
  rangeLabel,
  onOpenJournal,
  setHeaderActions,
}: {
  accounts: LedgerAccount[];
  dateRange: DateRange;
  locationFilter: string | null;
  revision: number;
  rangeLabel: string;
  /** Takes the reader to where the difference is actually fixed. */
  onOpenJournal: () => void;
  setHeaderActions: HeaderActionsSetter;
}) {
  const { shop } = useAuth();
  const [feeds, setFeeds] = useState<FeedFigures>({});
  const [movements, setMovements] = useState<AccountMovement[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { since, until } = dateRange;

  const reload = useCallback(async () => {
    if (!shop) return;
    try {
      // The two halves of every balance, fetched together: what the shop's own
      // records report, and what has been posted by hand.
      const [snapshot, movement] = await Promise.all([
        fetchLedgerSnapshot({ shopId: shop.id, since, until, locationFilter }),
        // Movement is NOT date-scoped, and this is the one asymmetry on the
        // screen. A posted account holds an opening balance plus everything
        // ever posted to it -- a loan taken out last year is still owed -- so
        // limiting it to the range would report the loan as repaid.
        ledgerAccountMovement(shop.id),
      ]);
      setFeeds(snapshot.feeds);
      setMovements(movement);
      setError(null);
    } catch (err) {
      setError(extractErrorMessage(err));
    } finally {
      setLoaded(true);
    }
  }, [shop, since, until, locationFilter]);

  useEffect(() => {
    reload();
  }, [reload, revision]);

  const balance = useMemo(() => trialBalance(accounts, feeds, movements), [accounts, feeds, movements]);

  const columns: Column<AccountBalance>[] = useMemo(
    () => [
      {
        key: 'account',
        header: 'Account',
        render: (row) => (
          <NameCell
            title={`${row.account.code}  ${row.account.name}`}
            meta={row.basis === 'feed' ? 'reported' : 'posted'}
          />
        ),
      },
      {
        key: 'debit',
        header: 'Debit',
        numeric: true,
        width: 120,
        render: (row) =>
          row.debitCents > 0 ? <ValueCell value={formatAccountingCents(row.debitCents)} strong /> : <ValueCell value="" />,
      },
      {
        key: 'credit',
        header: 'Credit',
        numeric: true,
        width: 120,
        render: (row) =>
          row.creditCents > 0 ? <ValueCell value={formatAccountingCents(row.creditCents)} strong /> : <ValueCell value="" />,
      },
    ],
    []
  );

  useHeaderActions(
    setHeaderActions,
    <ExportMenu rows={balance.rows} columns={EXPORT_COLUMNS} title="Trial balance" subtitle={rangeLabel} filenamePrefix="trial-balance" />,
    [balance.rows, rangeLabel]
  );

  return (
    <>
      <BentoCard title="Do the books balance?" scope={rangeLabel}>
        <View style={styles.metricRow}>
          <StatTile variant="bento" value={formatCompactCents(balance.totalDebitCents)} label="Total debits" />
          <StatTile variant="bento" value={formatCompactCents(balance.totalCreditCents)} label="Total credits" />
          <StatTile
            variant="bento"
            value={balance.balanced ? 'Balanced' : formatCompactCents(Math.abs(balance.differenceCents))}
            label={balance.balanced ? 'Debits meet credits' : 'Difference'}
            hint={balance.balanced ? undefined : balance.differenceCents > 0 ? 'debits exceed credits' : 'credits exceed debits'}
          />
        </View>

        {!balance.balanced && loaded ? (
          <View style={styles.caveatWrap}>
            {/* `wrong`, and it earns the tone: the trial balance is not
                telling the truth about the business until this closes. It gets
                an action, because a `wrong` with no fix teaches people to
                ignore the whole family of caveats. */}
            <Caveat tone="wrong" action={{ label: 'Open the journal', onPress: onOpenJournal }}>
              {`The two columns are ${formatAccountingCents(Math.abs(balance.differenceCents))} apart. That is almost always an opening balance nobody has stated yet — what the owner put in, and any profit kept from before these books started. Post it to Owner's equity or Retained earnings and this closes.`}
            </Caveat>
          </View>
        ) : null}
      </BentoCard>

      <BentoCard title="Trial balance" scope={rangeLabel} bodyStyle={styles.tableBody}>
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <DataTable
          columns={columns}
          rows={balance.rows}
          keyExtractor={(row) => row.account.id}
          emptyLabel={loaded ? 'Nothing to report yet.' : 'Loading…'}
          minWidth={620}
        />
        <View style={styles.totalRow}>
          <Text style={styles.totalLabel}>Totals</Text>
          <Text style={styles.totalValue}>{formatAccountingCents(balance.totalDebitCents)}</Text>
          <Text style={styles.totalValue}>{formatAccountingCents(balance.totalCreditCents)}</Text>
        </View>
        <Text style={styles.footnote}>
          Balances shown are what the shop holds today; income and expenses cover {rangeLabel.toLowerCase()}. A
          reported account fills itself in from sales, stock, cash and bills — a posted one holds only what the
          journal put there.
        </Text>
      </BentoCard>
    </>
  );
}

const styles = StyleSheet.create({
  tableBody: { paddingHorizontal: 10 },
  metricRow: { flexDirection: 'row', gap: 10, flexWrap: 'wrap' },
  caveatWrap: { marginTop: 14 },
  // Matches DataTable's own column widths so the totals line up under the
  // figures they total. Hand-built rather than added as a table row: a totals
  // row that scrolls away with the columns is a totals row nobody sees.
  totalRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingTop: 12,
    marginTop: 4,
    borderTopWidth: 1,
    borderTopColor: theme.bentoRule,
  },
  totalLabel: { flex: 1, fontSize: 13, fontWeight: '800', color: theme.bentoInk, paddingHorizontal: 8 },
  totalValue: { width: 120, textAlign: 'right', paddingHorizontal: 8, fontSize: 13.5, fontWeight: '800', color: theme.bentoInk, fontVariant: ['tabular-nums'] },
  footnote: { fontSize: 11, color: theme.bentoMuted, marginTop: 14, paddingHorizontal: 8, lineHeight: 16 },
  error: { color: theme.bentoLoss, fontSize: 12, fontWeight: '700', marginBottom: 10, paddingHorizontal: 8 },
});
