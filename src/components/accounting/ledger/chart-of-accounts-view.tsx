import { useCallback, useEffect, useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { type LedgerView } from '@/components/accounting/ledger/ledger-hub';
import { ReportExport } from '@/components/accounting/reports/report-export';
import { useTabRefresh, type HeaderActionsSetter, type RefreshSetter } from '@/components/accounting/use-header-actions';
import { StatTile } from '@/components/stat-tile';
import { BentoCard } from '@/components/ui/bento-card';
import { Caveat } from '@/components/ui/caveat';
import { DataTable, NameCell, ValueCell, type Column } from '@/components/ui/data-table';
import { Colors } from '@/constants/theme';
import { useAuth } from '@/hooks/use-auth';
import { useRefreshOnFocus } from '@/hooks/use-refresh-on-focus';
import { formatCents, formatCompactCents } from '@/lib/currency';
import { listAccounts, listPostedLines } from '@/lib/ledger';
import { toDateColumn } from '@/lib/period';
import { accountingEquation, groupAccountsByType, type AccountGroup } from '@/lib/ledger-view';
import type { Account } from '@/types/models';

const theme = Colors.light;

type Row = { kind: 'account'; account: Account; balanceCents: number } | { kind: 'section'; group: AccountGroup };

const COLUMNS: Column<Row>[] = [
  {
    key: 'code',
    header: 'Code',
    width: 74,
    render: (row) =>
      row.kind === 'section' ? <Text style={styles.section}>{row.group.label}</Text> : <ValueCell value={row.account.code} tone="muted" />,
    // A section heading has no code. Exporting its label here instead would put
    // "Assets" in a column of account numbers.
    text: (row) => (row.kind === 'section' ? '' : row.account.code),
  },
  {
    key: 'name',
    header: 'Account',
    render: (row) =>
      row.kind === 'section' ? (
        <ValueCell value="" tone="muted" />
      ) : (
        <NameCell
          title={row.account.name}
          // The flag is what tells a reader why 1590 subtracts. Without it the
          // row reads as an asset that happens to be negative.
          meta={row.account.isContra ? 'reduces its section' : undefined}
        />
      ),
    // The section's own label lands in THIS column, so a flat file still shows
    // where each block starts -- the one piece of the chart's shape a CSV can
    // carry without an indentation column nothing can compute on.
    text: (row) =>
      row.kind === 'section'
        ? row.group.label
        : row.account.isContra
          ? `${row.account.name} (reduces its section)`
          : row.account.name,
  },
  {
    key: 'balance',
    header: 'Balance',
    numeric: true,
    render: (row) =>
      row.kind === 'section' ? (
        <ValueCell value={formatCents(row.group.subtotalCents)} strong />
      ) : (
        <ValueCell value={formatCents(row.balanceCents)} />
      ),
    text: (row) => formatCents(row.kind === 'section' ? row.group.subtotalCents : row.balanceCents),
  },
];

export function ChartOfAccountsView({
  setRefresh,
  setHeaderActions,
  onOpenView,
}: {
  setRefresh: RefreshSetter;
  setHeaderActions: HeaderActionsSetter;
  onOpenView: (view: LedgerView) => void;
}) {
  const { shop } = useAuth();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [balances, setBalances] = useState(new Map<string, number>());
  const [loaded, setLoaded] = useState(false);

  const reload = useCallback(async () => {
    if (!shop) return;
    // toDateColumn, not toISOString: the latter converts to UTC first, so an
    // evening query west of Greenwich would ask for tomorrow.
    const today = toDateColumn(new Date());
    const [rows, lines] = await Promise.all([listAccounts(shop.id), listPostedLines(shop.id, today)]);
    const map = new Map<string, number>();
    for (const line of lines) map.set(line.accountId, (map.get(line.accountId) ?? 0) + line.amountCents);
    setAccounts(rows);
    setBalances(map);
    setLoaded(true);
  }, [shop]);

  // `reload()` bare, matching receivables-tab.tsx:85. `void reload()` trips
  // react-hooks' cascading-render rule; the call itself is the same.
  useEffect(() => { reload(); }, [reload]);
  useRefreshOnFocus(reload);
  useTabRefresh(setRefresh, reload);

  const groups = useMemo(
    () => groupAccountsByType(accounts, [...balances].map(([accountId, amountCents]) => ({ accountId, amountCents }))),
    [accounts, balances]
  );
  const equation = useMemo(() => accountingEquation(groups), [groups]);

  // Section headers are rows rather than separate cards. Six cards each holding
  // four rows is six tables to scan; one table with six rules down it is a
  // chart of accounts, which is what an accountant is expecting to see.
  const rows = useMemo<Row[]>(
    () =>
      groups.flatMap((group) => [
        { kind: 'section' as const, group },
        ...group.accounts
          .filter((a) => a.archivedAt === null)
          .map((account) => ({ kind: 'account' as const, account, balanceCents: balances.get(account.id) ?? 0 })),
      ]),
    [groups, balances]
  );

  return (
    <View style={styles.wrap}>
      <ReportExport
        setHeaderActions={setHeaderActions}
        rows={rows}
        columns={COLUMNS}
        title="Chart of Accounts"
        // A position read at an instant, so the file is stamped with the
        // moment rather than a window it never honoured.
        rangeLabel={null}
        locationFilter={null}
        filenamePrefix="chart-of-accounts"
      />
      <BentoCard title="Right now" scope="As of today">
        <View style={styles.tiles}>
          <StatTile value={formatCompactCents(equation.assetsCents)} label="Assets" variant="bento" />
          <StatTile value={formatCompactCents(equation.liabilitiesCents)} label="Liabilities" variant="bento" />
          <StatTile value={formatCompactCents(equation.equityCents)} label="Equity" variant="bento" />
          <StatTile
            value={equation.differenceCents === 0 ? 'A = L + E' : formatCompactCents(equation.differenceCents)}
            label="Check"
            hint={equation.differenceCents === 0 ? 'the books balance' : 'they do not'} variant="bento" />
        </View>
        {equation.differenceCents !== 0 && (
          <Caveat tone="wrong" action={{ label: 'Open the trial balance', onPress: () => onOpenView('trial') }}>
            {`Assets are out by ${formatCents(equation.differenceCents)} against liabilities plus equity. Every entry balances individually, so this means an account is typed into the wrong section.`}
          </Caveat>
        )}
      </BentoCard>

      {/* Out of the grid: a chart of accounts is read down a column. */}
      <BentoCard title="Accounts" bodyStyle={styles.tableBody}>
        <DataTable
          columns={COLUMNS}
          rows={rows}
          keyExtractor={(row) => (row.kind === 'section' ? `section-${row.group.type}` : row.account.id)}
          emptyLabel={loaded ? 'No accounts yet.' : 'Loading…'}
        />
      </BentoCard>

      <Caveat tone="context">
        An account that has been posted to can be renamed or archived, but never deleted or re-typed — that would silently
        change every past statement it appears in.
      </Caveat>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 14 },
  tiles: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  tableBody: { paddingHorizontal: 10 },
  section: { fontSize: 10.5, fontWeight: '800', letterSpacing: 0.7, textTransform: 'uppercase', color: theme.bentoMuted },
});
