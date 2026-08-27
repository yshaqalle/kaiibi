import { useCallback, useEffect, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { useTabRefresh, type RefreshSetter } from '@/components/accounting/use-header-actions';
import { type DateRange } from '@/components/range-selector';
import { StatTile } from '@/components/stat-tile';
import { BentoCard } from '@/components/ui/bento-card';
import { Caveat } from '@/components/ui/caveat';
import { DataTable, NameCell, ValueCell, type Column } from '@/components/ui/data-table';
import { useAuth } from '@/hooks/use-auth';
import { useRefreshOnFocus } from '@/hooks/use-refresh-on-focus';
import { movementTotals, type MovementKind, type MovementRow } from '@/lib/report-math';
import { loadStockMovement } from '@/lib/reports';

// Deliveries, transfers and stock-takes, as one sequence.
//
// The three tables are merged and ordered in reports.ts, not here -- see the
// note there. This screen renders what it is given and does no arithmetic
// beyond calling movementTotals.

const KIND_LABEL: Record<MovementKind, string> = {
  received: 'Received',
  transfer: 'Transfer',
  count: 'Stock-take',
};

const COLUMNS: Column<MovementRow>[] = [
  {
    key: 'when',
    header: 'When',
    width: 116,
    // `at` is a TIMESTAMP (created_at, timestamptz), not a date column, so
    // parsing it is safe: it carries an offset. The UTC-midnight trap this
    // project shipped once applies to date-only strings, which none of these
    // three tables uses. See the note on MovementRow.
    render: (row) => <ValueCell value={new Date(row.at).toLocaleDateString()} tone="muted" />,
  },
  {
    key: 'what',
    header: 'What',
    render: (row) => <NameCell title={row.what} meta={row.detail ?? undefined} />,
  },
  {
    key: 'kind',
    header: 'Kind',
    width: 104,
    render: (row) => <ValueCell value={KIND_LABEL[row.kind]} tone="muted" />,
  },
  { key: 'where', header: 'Where', render: (row) => <NameCell title={row.where} /> },
  {
    key: 'units',
    header: 'Units',
    numeric: true,
    render: (row) => {
      // A transfer moved stock rather than changing it, so it is neither a
      // gain nor a loss and is not coloured as one. A stock-take's variance is
      // signed and shown with its sign, because a write-off rendered as a
      // positive number is the one thing this report must never do.
      if (row.kind === 'transfer') return <ValueCell value={String(row.units)} tone="muted" />;
      if (row.units < 0) return <ValueCell value={String(row.units)} tone="danger" strong />;
      return <ValueCell value={`+${row.units}`} tone={row.units === 0 ? 'muted' : 'success'} strong />;
    },
  },
];

export function StockMovementView({
  dateRange,
  locationFilter,
  setRefresh,
}: {
  dateRange: DateRange;
  locationFilter: string | null;
  setRefresh: RefreshSetter;
}) {
  const { shop } = useAuth();
  const [rows, setRows] = useState<MovementRow[] | null>(null);

  const { since, until } = dateRange;
  const reload = useCallback(async () => {
    if (!shop) return;
    setRows(await loadStockMovement(shop.id, since, until, locationFilter));
  }, [shop, since, until, locationFilter]);

  // See the note in chart-of-accounts-view.tsx: use-refresh-on-focus does not
  // fetch on the mounting focus, and depends on this effect having done it.
  useEffect(() => { reload(); }, [reload]);
  useRefreshOnFocus(reload);
  useTabRefresh(setRefresh, reload);

  const totals = useMemo(() => movementTotals(rows ?? []), [rows]);

  return (
    <View style={styles.wrap}>
      <BentoCard title="What moved" scope="The chosen range">
        <View style={styles.tiles}>
          <StatTile
            value={`+${totals.received.units}`}
            label="Units received"
            hint={`${totals.received.count} ${totals.received.count === 1 ? 'delivery' : 'deliveries'}`}
            tone={totals.received.units > 0 ? 'positive' : 'default'}
            variant="bento"
          />
          <StatTile
            value={String(totals.transfer.units)}
            label="Units transferred"
            hint={`${totals.transfer.count} ${totals.transfer.count === 1 ? 'transfer' : 'transfers'}`}
            variant="bento"
          />
          <StatTile
            // Signed, never absolute. A stock-take that wrote 284 units off
            // reads "−284", and rendering it as a gain would invert the single
            // most important thing on this screen.
            value={totals.count.units > 0 ? `+${totals.count.units}` : String(totals.count.units)}
            label="Stock-take variance"
            hint={`${totals.count.count} ${totals.count.count === 1 ? 'count' : 'counts'}`}
            tone={totals.count.units < 0 ? 'warning' : 'default'}
            variant="bento"
          />
          <StatTile
            value={String(totals.received.count + totals.transfer.count + totals.count.count)}
            label="Records"
            variant="bento"
          />
        </View>
      </BentoCard>

      <BentoCard title="Every movement" bodyStyle={styles.tableBody}>
        <DataTable
          columns={COLUMNS}
          rows={rows ?? []}
          keyExtractor={(row) => `${row.kind}:${row.id}`}
          emptyLabel={rows ? 'No stock moved in this period.' : 'Loading…'}
          minWidth={680}
        />
      </BentoCard>

      <Caveat tone="context">
        Transfers are counted apart from the other two because a transfer moves stock between branches rather
        than changing how much the shop holds — adding it to deliveries would count the same units twice.
        Stock-take variance is signed: a negative figure is stock that was on the books and not on the shelf.
        Sales are not here; they are on the sales reports.
      </Caveat>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 14 },
  tiles: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  tableBody: { paddingHorizontal: 10 },
});
