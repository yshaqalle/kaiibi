import { useCallback, useEffect, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { type LedgerView } from '@/components/accounting/ledger/ledger-hub';
import { useTabRefresh, type RefreshSetter } from '@/components/accounting/use-header-actions';
import { StatTile } from '@/components/stat-tile';
import { BentoCard } from '@/components/ui/bento-card';
import { Caveat } from '@/components/ui/caveat';
import { DataTable, NameCell, ValueCell, type Column } from '@/components/ui/data-table';
import { useAuth } from '@/hooks/use-auth';
import { useRefreshOnFocus } from '@/hooks/use-refresh-on-focus';
import { formatCents, formatCompactCents } from '@/lib/currency';
import { listAccounts, listPostedLines } from '@/lib/ledger';
import { toDateColumn } from '@/lib/period';
import { trialBalance, type TrialBalanceRow } from '@/lib/ledger-math';

const COLUMNS: Column<TrialBalanceRow>[] = [
  { key: 'code', header: 'Code', width: 74, render: (row) => <ValueCell value={row.code} tone="muted" /> },
  { key: 'name', header: 'Account', render: (row) => <NameCell title={row.name} /> },
  {
    key: 'debit',
    header: 'Debit',
    numeric: true,
    // An em dash, not 0.00. A trial balance has one figure per row and the
    // empty side is empty; printing zeroes down both columns doubles the ink
    // and halves the speed of finding the number that matters.
    render: (row) => (
      <ValueCell value={row.debitCents === 0 ? '—' : formatCents(row.debitCents)} tone={row.debitCents === 0 ? 'muted' : 'default'} />
    ),
  },
  {
    key: 'credit',
    header: 'Credit',
    numeric: true,
    render: (row) => (
      <ValueCell value={row.creditCents === 0 ? '—' : formatCents(row.creditCents)} tone={row.creditCents === 0 ? 'muted' : 'default'} />
    ),
  },
];

export function TrialBalanceView({
  setRefresh,
  onOpenView,
}: {
  setRefresh: RefreshSetter;
  onOpenView: (view: LedgerView) => void;
}) {
  const { shop } = useAuth();
  const [rows, setRows] = useState<TrialBalanceRow[]>([]);
  const [loaded, setLoaded] = useState(false);

  const reload = useCallback(async () => {
    if (!shop) return;
    // toDateColumn, not toISOString: the latter converts to UTC first, so an
    // evening query west of Greenwich would ask for tomorrow.
    const today = toDateColumn(new Date());
    const [accounts, lines] = await Promise.all([listAccounts(shop.id), listPostedLines(shop.id, today)]);
    setRows(trialBalance(accounts, lines));
    setLoaded(true);
  }, [shop]);

  // See the note in chart-of-accounts-view.tsx: use-refresh-on-focus does not
  // fetch on the mounting focus, and depends on this effect having done it.
  useEffect(() => { reload(); }, [reload]);
  useRefreshOnFocus(reload);
  useTabRefresh(setRefresh, reload);

  const totals = useMemo(
    () =>
      rows.reduce(
        (acc, row) => ({ debitCents: acc.debitCents + row.debitCents, creditCents: acc.creditCents + row.creditCents }),
        { debitCents: 0, creditCents: 0 }
      ),
    [rows]
  );
  const differenceCents = totals.debitCents - totals.creditCents;

  return (
    <View style={styles.wrap}>
      <BentoCard title="As of today" scope="Every posted entry">
        <View style={styles.tiles}>
          <StatTile value={formatCompactCents(totals.debitCents)} label="Total debits" variant="bento" />
          <StatTile value={formatCompactCents(totals.creditCents)} label="Total credits" variant="bento" />
          <StatTile
            value={differenceCents === 0 ? 'Balanced' : formatCompactCents(differenceCents)}
            label="Difference"
            hint={differenceCents === 0 ? 'debits = credits' : 'this should be impossible'} variant="bento" />
        </View>
      </BentoCard>

      <BentoCard title="Accounts" bodyStyle={styles.tableBody}>
        <DataTable
          columns={COLUMNS}
          rows={rows}
          keyExtractor={(row) => row.accountId}
          emptyLabel={loaded ? 'Nothing has been posted yet.' : 'Loading…'}
        />
      </BentoCard>

      {differenceCents === 0 ? (
        <Caveat tone="context">
          This cannot fail to balance: the database refuses an entry whose debits and credits differ, so the proof is shown
          rather than computed. A trial balance that does not show its own proof is not one.
        </Caveat>
      ) : (
        <Caveat tone="wrong" action={{ label: 'Check the audit log', onPress: () => onOpenView('audit') }}>
          {`Debits and credits differ by ${formatCents(differenceCents)}. Every entry is checked at the database, so this means a row was written by something that bypassed it.`}
        </Caveat>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 14 },
  tiles: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  tableBody: { paddingHorizontal: 10 },
});
