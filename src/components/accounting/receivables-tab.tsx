import { useCallback, useEffect, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { AgingStrip } from '@/components/accounting/aging-strip';
import { useTabRefresh, type RefreshSetter } from '@/components/accounting/use-header-actions';
import { StatTile } from '@/components/stat-tile';
import { BentoCard } from '@/components/ui/bento-card';
import { Caveat } from '@/components/ui/caveat';
import { DataTable, NameCell, ValueCell, type Column } from '@/components/ui/data-table';
import { useAuth } from '@/hooks/use-auth';
import { useRefreshOnFocus } from '@/hooks/use-refresh-on-focus';
import { listOutstanding, type CustomerBalance } from '@/lib/balances';
import { agingTotals, inBucket, type AgingBucket } from '@/lib/aging';
import { ageLabel, daysOwed, groupByCustomer, type Receivable } from '@/lib/receivables';
import { formatCents, formatCompactCents } from '@/lib/currency';

// Built for a fixed clock rather than reading Date.now() while rendering. Two
// reasons, and the lint rule is the lesser: an impure render can print a
// different age for the same row on a re-render, and a table whose "Waiting"
// column ticks over mid-scroll is worse than one that is a few seconds stale.
function buildColumns(now: number): Column<Receivable>[] {
  return [
    {
      key: 'customer',
    header: 'Customer',
    render: (row) => (
      <NameCell
        title={row.customerName || 'Unnamed customer'}
        meta={row.saleCount > 1 ? `${row.saleCount} unpaid sales` : undefined}
      />
    ),
  },
  {
    key: 'owed',
    header: 'Owed',
    numeric: true,
    render: (row) => <ValueCell value={formatCents(row.owedCents)} strong />,
  },
  {
    key: 'since',
    header: 'Unpaid since',
    numeric: true,
    render: (row) => (
      <ValueCell value={new Date(row.oldestAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} tone="muted" />
    ),
  },
  {
    key: 'age',
    header: 'Waiting',
    numeric: true,
    render: (row) => {
      const days = daysOwed(row.oldestAt, now);
      // A debt over a month old is the one worth chasing, so it says so in the
      // colour as well as the number -- with the number carrying it, because
      // colour alone is never the signal.
      return <ValueCell value={ageLabel(days)} tone={days >= 30 ? 'warning' : 'muted'} />;
    },
    },
  ];
}

export function ReceivablesTab({
  setRefresh,
  initialBucket = null,
}: {
  setRefresh: RefreshSetter;
  /**
   * Set by the Reports hub's Aging Receivables card, which opens this tab with
   * a bucket already chosen. The card is the report; this tab is where it runs.
   */
  initialBucket?: AgingBucket | null;
}) {
  const { shop } = useAuth();
  const [rows, setRows] = useState<CustomerBalance[]>([]);
  // The clock these ages are measured against, stamped when the rows arrived.
  // Zero until then, which reads as "today" -- and there are no rows to age yet.
  const [readAt, setReadAt] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!shop) return;
    try {
      setRows(await listOutstanding(shop.id));
      setReadAt(Date.now());
      setError(null);
    } catch {
      // Said rather than shown as an empty list: "nobody owes you anything" and
      // "this did not load" look identical otherwise, and only one of them is
      // good news.
      setError('Could not load what is outstanding. Pull to refresh.');
    }
  }, [shop]);

  // The initial fetch. useRefreshOnFocus deliberately skips the focus that
  // arrives with mounting and documents this effect as the thing that does it --
  // so every accounting tab carries the same one, and the same lint complaint.
  useEffect(() => { reload(); }, [reload]);
  useRefreshOnFocus(reload);
  useTabRefresh(setRefresh, reload);

  const receivables = useMemo(() => groupByCustomer(rows), [rows]);
  const [bucket, setBucket] = useState<AgingBucket | null>(initialBucket);
  // Aged from the day of the SALE, because a kaiibi sale carries no due date --
  // see lib/aging.ts. The clock is `readAt`, the same fixed stamp the Waiting
  // column uses, so a row cannot sit in one bucket and print an age from
  // another.
  const ageOf = useCallback((row: Receivable) => daysOwed(row.oldestAt, readAt), [readAt]);
  const buckets = useMemo(() => agingTotals(receivables, { days: ageOf, cents: (r) => r.owedCents }), [receivables, ageOf]);
  const shown = useMemo(() => inBucket(receivables, bucket, ageOf), [receivables, bucket, ageOf]);
  const columns = useMemo(() => buildColumns(readAt), [readAt]);
  const totalCents = receivables.reduce((sum, row) => sum + row.owedCents, 0);
  const overThirty = receivables.filter((row) => daysOwed(row.oldestAt, readAt) >= 30).length;

  return (
    <View style={styles.body}>
      <BentoCard title="Owed to the shop" scope="right now">
        <View style={styles.metricRow}>
          <StatTile
            value={formatCompactCents(totalCents)}
            label="Owed to you"
            hint={receivables.length === 1 ? 'from 1 customer' : `from ${receivables.length} customers`}
            variant="bento"
          />
          <StatTile
            value={String(overThirty)}
            label="Over 30 days"
            hint="worth a phone call"
            tone={overThirty > 0 ? 'warning' : 'default'}
            variant="bento"
          />
        </View>

        {/* The specific misunderstanding to prevent: an owner reading this as
            money still to come IN on top of what they have already earned. It is
            not a forecast -- every cent of it was recognised as revenue on the
            day the goods left the shop. `context` because the figure is right
            and there is nothing to fix. */}
        <Caveat tone="context">
          Already counted as revenue on the day of the sale, not income still to come. This is how much of
          it is sitting with customers rather than in the till.
        </Caveat>
      </BentoCard>

      {/* Out of any grid: a collections list is read down a column, and a table
          in a half-width cell loses its gutters for nothing. */}
      <BentoCard title="How old the money is" scope="right now">
        <AgingStrip totals={buckets} selected={bucket} onSelect={setBucket} />
      </BentoCard>

      <BentoCard
        title={bucket ? `Who owes what · ${buckets.find((b) => b.key === bucket)?.label}` : 'Who owes what'}
        bodyStyle={styles.tableBody}
      >
        {error ? (
          <Caveat tone="wrong" action={{ label: 'Try again', onPress: () => { reload(); } }}>
            {error}
          </Caveat>
        ) : (
          <DataTable
            columns={columns}
            rows={shown}
            keyExtractor={(row) => row.customerId}
            emptyLabel={bucket ? 'Nothing in this bucket.' : 'Nobody owes the shop anything.'}
          />
        )}
      </BentoCard>
    </View>
  );
}

const styles = StyleSheet.create({
  body: { gap: 14 },
  metricRow: { flexDirection: 'row', gap: 10, flexWrap: 'wrap' },
  // 10, not the card's usual 18: the table brings its own gutters.
  tableBody: { paddingHorizontal: 10 },
});
