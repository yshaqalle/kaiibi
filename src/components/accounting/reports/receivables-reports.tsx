import { useCallback, useEffect, useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { useHeaderActions, type HeaderActionsSetter } from '@/components/accounting/use-header-actions';
import { ExportMenu } from '@/components/export-menu';
import { StatTile } from '@/components/stat-tile';
import { BentoCard } from '@/components/ui/bento-card';
import { Caveat } from '@/components/ui/caveat';
import { DataTable, NameCell, ValueCell, type Column } from '@/components/ui/data-table';
import { Colors } from '@/constants/theme';
import { useAuth } from '@/hooks/use-auth';
import { listOutstanding, type CustomerBalance } from '@/lib/balances';
import type { CsvColumn } from '@/lib/csv';
import { formatAccountingCents, formatCompactCents } from '@/lib/currency';
import {
  ageReceivables,
  customerBalanceSummary,
  type AgedReceivable,
  type CustomerBalanceSummaryRow,
} from '@/lib/receivable-aging';
import { ageLabel } from '@/lib/receivables';

const theme = Colors.light;

// Two reports over one set of rows: what is owed by age, and what is owed by
// customer.
//
// They look similar enough that it is worth saying why both exist. The aging
// report is about RISK -- money the shop is progressively less likely to see,
// which is why it is bucketed and ordered oldest first. The balance summary is
// about a PERSON -- it is what you read down when reconciling an account or
// print to hand to a customer, so it is ordered by size and carries the number
// of unpaid sales behind each figure.
//
// Both are "right now" facts and neither obeys the date range, which the cards
// say rather than leaving the reader to notice that the numbers do not move.

/** Shared fetch. Both reports read the same view, so neither refetches for the other. */
function useOutstanding() {
  const { shop } = useAuth();
  const [rows, setRows] = useState<CustomerBalance[]>([]);
  // The clock the ages are measured against, stamped when the rows arrived.
  // Read once rather than during render, so a table's "Waiting" column does
  // not tick over mid-scroll -- the same reasoning receivables-tab.tsx uses.
  const [readAt, setReadAt] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!shop) return;
    try {
      setRows(await listOutstanding(shop.id));
      setReadAt(Date.now());
      setError(null);
    } catch {
      // Said, not shown as an empty list: "nobody owes you anything" and "this
      // did not load" look identical otherwise, and only one is good news.
      setError('Could not load what is outstanding.');
    } finally {
      setLoaded(true);
    }
  }, [shop]);

  useEffect(() => {
    reload();
  }, [reload]);

  return { rows, readAt, loaded, error };
}

const AGING_EXPORT_COLUMNS: CsvColumn<AgedReceivable>[] = [
  { header: 'Customer', value: (r) => r.customerName || 'Unnamed customer' },
  { header: 'Owed', value: (r) => (r.owedCents / 100).toFixed(2) },
  { header: 'Unpaid sales', value: (r) => String(r.saleCount) },
  { header: 'Oldest debt', value: (r) => r.oldestAt.slice(0, 10) },
  { header: 'Days', value: (r) => String(r.days) },
  { header: 'Bucket', value: (r) => r.bucketKey },
];

export function AgingReceivablesReport({ setHeaderActions }: { setHeaderActions: HeaderActionsSetter }) {
  const { rows, readAt, loaded, error } = useOutstanding();
  const aging = useMemo(() => ageReceivables(rows, readAt), [rows, readAt]);

  const columns: Column<AgedReceivable>[] = useMemo(
    () => [
      {
        key: 'customer',
        header: 'Customer',
        render: (row) => (
          <NameCell
            title={row.customerName || 'Unnamed customer'}
            meta={row.saleCount > 1 ? `${row.saleCount} unpaid sales` : '1 unpaid sale'}
          />
        ),
      },
      {
        key: 'owed',
        header: 'Owed',
        numeric: true,
        width: 120,
        render: (row) => <ValueCell value={formatAccountingCents(row.owedCents)} strong />,
      },
      {
        key: 'age',
        header: 'Waiting',
        numeric: true,
        width: 110,
        // The number carries the signal and the colour reinforces it — colour
        // alone is never the signal (see the bento notes).
        render: (row) => <ValueCell value={ageLabel(row.days)} tone={row.days >= 60 ? 'danger' : row.days >= 30 ? 'warning' : 'muted'} />,
      },
      {
        key: 'bucket',
        header: 'Band',
        numeric: true,
        width: 140,
        render: (row) => (
          <ValueCell value={aging.buckets.find((bucket) => bucket.key === row.bucketKey)?.label ?? ''} tone="muted" />
        ),
      },
    ],
    [aging.buckets]
  );

  useHeaderActions(
    setHeaderActions,
    <ExportMenu rows={aging.rows} columns={AGING_EXPORT_COLUMNS} title="Aged receivables" subtitle="As of today" filenamePrefix="aged-receivables" />,
    [aging.rows]
  );

  return (
    <>
      <BentoCard title="How old is the money owed to you?" scope="As of today">
        <View style={styles.metricRow}>
          <StatTile variant="bento" value={formatCompactCents(aging.totalOwedCents)} label="Owed in total" hint={`${aging.rows.length} customer${aging.rows.length === 1 ? '' : 's'}`} />
          <StatTile variant="bento" value={formatCompactCents(aging.atRiskCents)} label="Waiting 60 days or more" hint="the part worth worrying about" />
        </View>

        <View style={styles.bucketRow}>
          {aging.buckets.map((bucket) => (
            <View key={bucket.key} style={styles.bucket}>
              <Text style={styles.bucketAmount}>{formatAccountingCents(bucket.owedCents)}</Text>
              <Text style={styles.bucketLabel}>{bucket.label}</Text>
              <Text style={styles.bucketMeta}>
                {bucket.customerCount === 0 ? 'nobody' : `${bucket.customerCount} · ${bucket.pct}%`}
              </Text>
            </View>
          ))}
        </View>

        {aging.atRiskCents > 0 ? (
          <Caveat tone="context">
            A customer is aged on their OLDEST unpaid sale, not on each sale separately — nobody chases the part of a
            debt that is 40 days old. Anything past 60 days is money most shops assume they may not collect.
          </Caveat>
        ) : null}
      </BentoCard>

      <BentoCard title="Aged receivables" scope="As of today" bodyStyle={styles.tableBody}>
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <DataTable
          columns={columns}
          rows={aging.rows}
          keyExtractor={(row) => row.customerId}
          emptyLabel={loaded ? 'Nobody owes the shop anything.' : 'Loading…'}
          minWidth={640}
        />
        <Text style={styles.footnote}>
          What is owed is a fact about right now, not about the selected range — a sale from four months ago that was
          never paid is exactly the one this report exists to surface.
        </Text>
      </BentoCard>
    </>
  );
}

const SUMMARY_EXPORT_COLUMNS: CsvColumn<CustomerBalanceSummaryRow>[] = [
  { header: 'Customer', value: (r) => r.customerName },
  { header: 'Unpaid sales', value: (r) => String(r.saleCount) },
  { header: 'Balance', value: (r) => (r.owedCents / 100).toFixed(2) },
  { header: 'Oldest debt', value: (r) => r.oldestAt.slice(0, 10) },
  { header: 'Days waiting', value: (r) => String(r.days) },
];

export function CustomerBalanceSummaryReport({ setHeaderActions }: { setHeaderActions: HeaderActionsSetter }) {
  const { rows, readAt, loaded, error } = useOutstanding();
  const summary = useMemo(() => customerBalanceSummary(rows, readAt), [rows, readAt]);
  const totalCents = summary.reduce((sum, row) => sum + row.owedCents, 0);

  const columns: Column<CustomerBalanceSummaryRow>[] = useMemo(
    () => [
      {
        key: 'customer',
        header: 'Customer',
        render: (row) => (
          <NameCell title={row.customerName} meta={`${row.saleCount} unpaid sale${row.saleCount === 1 ? '' : 's'}`} />
        ),
      },
      {
        key: 'balance',
        header: 'Balance',
        numeric: true,
        width: 130,
        render: (row) => <ValueCell value={formatAccountingCents(row.owedCents)} strong />,
      },
      {
        key: 'since',
        header: 'Oldest unpaid',
        numeric: true,
        width: 130,
        render: (row) => (
          <ValueCell
            value={new Date(row.oldestAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}
            tone="muted"
          />
        ),
      },
      {
        key: 'days',
        header: 'Waiting',
        numeric: true,
        width: 100,
        render: (row) => <ValueCell value={ageLabel(row.days)} tone={row.days >= 30 ? 'warning' : 'muted'} />,
      },
    ],
    []
  );

  useHeaderActions(
    setHeaderActions,
    <ExportMenu rows={summary} columns={SUMMARY_EXPORT_COLUMNS} title="Customer balances" subtitle="As of today" filenamePrefix="customer-balances" />,
    [summary]
  );

  return (
    <BentoCard title="Customer balance summary" scope="As of today" bodyStyle={styles.tableBody}>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <DataTable
        columns={columns}
        rows={summary}
        keyExtractor={(row) => row.customerId}
        emptyLabel={loaded ? 'Every sale has been paid for.' : 'Loading…'}
        minWidth={660}
      />
      <View style={styles.totalRow}>
        <Text style={styles.totalLabel}>{`${summary.length} customer${summary.length === 1 ? '' : 's'} owing`}</Text>
        <Text style={styles.totalValue}>{formatAccountingCents(totalCents)}</Text>
      </View>
      <Text style={styles.footnote}>
        One line per customer, largest balance first — this is the report to reconcile an account against or to hand
        to someone who asks what they owe. For how long each debt has been waiting, use Aged receivables.
      </Text>
    </BentoCard>
  );
}

const styles = StyleSheet.create({
  tableBody: { paddingHorizontal: 10 },
  metricRow: { flexDirection: 'row', gap: 10, flexWrap: 'wrap' },
  bucketRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 14 },
  bucket: { flexGrow: 1, flexBasis: 140, backgroundColor: theme.bentoSoft, borderRadius: 14, padding: 12 },
  bucketAmount: { fontSize: 16, fontWeight: '800', color: theme.bentoInk, letterSpacing: -0.4, fontVariant: ['tabular-nums'] },
  bucketLabel: { fontSize: 11.5, fontWeight: '700', color: theme.bentoInk2, marginTop: 3 },
  bucketMeta: { fontSize: 10.5, color: theme.bentoMuted, marginTop: 2 },
  totalRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 16, paddingTop: 12, marginTop: 4, borderTopWidth: 1, borderTopColor: theme.bentoRule },
  totalLabel: { fontSize: 13, fontWeight: '800', color: theme.bentoInk },
  totalValue: { fontSize: 14, fontWeight: '800', color: theme.bentoInk, fontVariant: ['tabular-nums'] },
  footnote: { fontSize: 11, color: theme.bentoMuted, marginTop: 14, paddingHorizontal: 8, lineHeight: 16 },
  error: { color: theme.bentoLoss, fontSize: 12, fontWeight: '700', marginBottom: 10, paddingHorizontal: 8 },
});
