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
import { formatCents } from '@/lib/currency';
import { listJournalEntries } from '@/lib/ledger';
import { entryDateLabel } from '@/lib/ledger-view';
import { toDateColumn } from '@/lib/period';
import { debitOf } from '@/lib/ledger-math';
import type { JournalEntry } from '@/types/models';

// The entry's size is the sum of its DEBITS, not of all its lines -- which is
// zero for every entry ever written. An "amount" column reading 0.00 down the
// whole table is the first thing a reader would report as broken.
function entrySizeCents(entry: JournalEntry): number {
  return entry.lines.reduce((sum, line) => sum + debitOf(line.amountCents), 0);
}

const COLUMNS: Column<JournalEntry>[] = [
  { key: 'ref', header: 'Ref', width: 96, render: (row) => <ValueCell value={row.reference ?? '—'} tone="muted" /> },
  {
    key: 'date',
    header: 'Date',
    width: 84,
    render: (row) => (
      <ValueCell value={entryDateLabel(row.entryDate)} tone="muted" />
    ),
  },
  {
    key: 'description',
    header: 'Entry',
    render: (row) => (
      <NameCell
        title={row.description}
        meta={row.status === 'reversed' ? 'reversed — see the mirror entry' : `${row.lines.length} lines · ${row.source}`}
      />
    ),
  },
  { key: 'amount', header: 'Amount', numeric: true, render: (row) => <ValueCell value={formatCents(entrySizeCents(row))} strong /> },
];

export function JournalsView({ dateRange, setRefresh }: { dateRange: DateRange; setRefresh: RefreshSetter }) {
  const { shop } = useAuth();
  const [entries, setEntries] = useState<JournalEntry[]>([]);
  const [loaded, setLoaded] = useState(false);

  const reload = useCallback(async () => {
    if (!shop) return;
    const from = toDateColumn(dateRange.since);
    // `until` is optional and means "through today" -- range-selector.tsx:22.
    const to = toDateColumn(dateRange.until ?? new Date());
    setEntries(await listJournalEntries(shop.id, from, to));
    setLoaded(true);
  }, [shop, dateRange]);

  useEffect(() => { reload(); }, [reload]);
  useRefreshOnFocus(reload);
  useTabRefresh(setRefresh, reload);

  const manual = useMemo(() => entries.filter((e) => e.source === 'manual').length, [entries]);
  const reversed = useMemo(() => entries.filter((e) => e.status === 'reversed').length, [entries]);

  return (
    <View style={styles.wrap}>
      <BentoCard title="In this range">
        <View style={styles.tiles}>
          <StatTile value={String(entries.length)} label="Entries" variant="bento" />
          <StatTile value={String(manual)} label="Entered by hand" hint="the rest post themselves" variant="bento" />
          <StatTile value={String(reversed)} label="Reversed" hint="each linked to its mirror" variant="bento" />
        </View>
      </BentoCard>

      <BentoCard title="Journal entries" bodyStyle={styles.tableBody}>
        <DataTable
          columns={COLUMNS}
          rows={entries}
          keyExtractor={(row) => row.id}
          emptyLabel={loaded ? 'No entries in this range.' : 'Loading…'}
        />
      </BentoCard>

      <Caveat tone="context">
        Nothing posts here automatically yet. Sales, bills, payments and stock will write their own entries once the posting
        phase lands; until then this shows what has been entered by hand.
      </Caveat>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 14 },
  tiles: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  tableBody: { paddingHorizontal: 10 },
});
