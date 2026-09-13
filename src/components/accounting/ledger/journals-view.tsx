import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';

import { EntryDetail, useLedgerContext, type LedgerContext } from '@/components/accounting/ledger/entry-detail';
import { ReportExport } from '@/components/accounting/reports/report-export';
import { useTabRefresh, type HeaderActionsSetter, type RefreshSetter } from '@/components/accounting/use-header-actions';
import { type DateRange } from '@/components/range-selector';
import { StatTile } from '@/components/stat-tile';
import { BentoCard } from '@/components/ui/bento-card';
import { Caveat } from '@/components/ui/caveat';
import { DataTable, NameCell, ValueCell, type Column } from '@/components/ui/data-table';
import { TabPills } from '@/components/ui/tab-pills';
import { Colors } from '@/constants/theme';
import { useAuth } from '@/hooks/use-auth';
import { useRefreshOnFocus } from '@/hooks/use-refresh-on-focus';
import { formatCents } from '@/lib/currency';
import { listJournalEntries } from '@/lib/ledger';
import { readableDescription } from '@/lib/ledger-detail';
import { entryDateLabel } from '@/lib/ledger-view';
import { toDateColumn } from '@/lib/period';
import { debitOf } from '@/lib/ledger-math';
import type { JournalEntry } from '@/types/models';

const theme = Colors.light;

// The entry's size is the sum of its DEBITS, not of all its lines -- which is
// zero for every entry ever written. An "amount" column reading 0.00 down the
// whole table is the first thing a reader would report as broken.
function entrySizeCents(entry: JournalEntry): number {
  return entry.lines.reduce((sum, line) => sum + debitOf(line.amountCents), 0);
}

type RangeBy = 'dated' | 'written';

function columnsFor(context: LedgerContext): Column<JournalEntry>[] {
  const describe = (row: JournalEntry) => readableDescription(row.description, context.names);
  return [
    { key: 'ref', header: 'Ref', width: 110, render: (row) => <ValueCell value={row.reference ?? '—'} tone="muted" />, text: (row) => row.reference ?? '—' },
    {
      key: 'date',
      header: 'Date',
      width: 72,
      render: (row) => <ValueCell value={entryDateLabel(row.entryDate)} tone="muted" />,
      text: (row) => entryDateLabel(row.entryDate),
    },
    {
      key: 'description',
      header: 'Entry',
      render: (row) => (
        <NameCell
          title={describe(row)}
          meta={
            row.status === 'reversed'
              ? 'reversed — see the mirror entry'
              : `${row.lines.length} lines · ${row.source} · ${context.personName(row.createdBy)}`
          }
        />
      ),
      // A reversed entry says so in the file too. Exporting only the description
      // would put a live-looking row in a spreadsheet for an entry that has been
      // undone.
      text: (row) => (row.status === 'reversed' ? `${describe(row)} (reversed)` : describe(row)),
    },
    {
      key: 'amount',
      header: 'Amount',
      numeric: true,
      width: 96,
      render: (row) => <ValueCell value={formatCents(entrySizeCents(row))} strong />,
      text: (row) => formatCents(entrySizeCents(row)),
    },
  ];
}

export function JournalsView({ dateRange, setRefresh, setHeaderActions, rangeLabel }: { dateRange: DateRange; setRefresh: RefreshSetter; setHeaderActions: HeaderActionsSetter; rangeLabel: string | null }) {
  const { shop } = useAuth();
  const { width } = useWindowDimensions();
  // Invoices' breakpoint: below it the pane would squeeze the table to nothing,
  // so the detail takes the card's place instead.
  const compact = width < 860;
  const [entries, setEntries] = useState<JournalEntry[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [by, setBy] = useState<RangeBy>('dated');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!shop) return;
    const from = toDateColumn(dateRange.since);
    // `until` is optional and means "through today" -- range-selector.tsx:22.
    const to = toDateColumn(dateRange.until ?? new Date());
    setEntries(await listJournalEntries(shop.id, from, to, by));
    setLoaded(true);
  }, [shop, dateRange, by]);

  useEffect(() => { reload(); }, [reload]);
  useRefreshOnFocus(reload);
  useTabRefresh(setRefresh, reload);

  const context = useLedgerContext(entries);
  const columns = useMemo(() => columnsFor(context), [context]);
  const selected = entries.find((e) => e.id === selectedId) ?? null;

  const manual = useMemo(() => entries.filter((e) => e.source === 'manual').length, [entries]);
  const reversed = useMemo(() => entries.filter((e) => e.status === 'reversed').length, [entries]);

  const detail = selected ? (
    <BentoCard>
      <EntryDetail key={selected.id} entry={selected} context={context} onClose={() => setSelectedId(null)} />
    </BentoCard>
  ) : null;

  const list = (
    <BentoCard
      title="Journal entries"
      bodyStyle={styles.tableBody}
      actions={
        <TabPills<RangeBy>
          options={[{ key: 'dated', label: 'Dated in range' }, { key: 'written', label: 'Written in range' }]}
          value={by}
          onChange={setBy}
        />
      }
    >
      <DataTable
        columns={columns}
        rows={entries}
        keyExtractor={(row) => row.id}
        onRowPress={(row) => setSelectedId(row.id)}
        selectedKey={selectedId}
        emptyLabel={loaded ? 'No entries in this range.' : 'Loading…'}
      />
    </BentoCard>
  );

  return (
    <View style={styles.wrap}>
      <ReportExport
        setHeaderActions={setHeaderActions}
        rows={entries}
        columns={columns}
        title="Journals"
        rangeLabel={rangeLabel}
        locationFilter={null}
        filenamePrefix="journals"
      />
      <BentoCard title="In this range">
        <View style={styles.tiles}>
          <StatTile value={String(entries.length)} label="Entries" variant="bento" />
          <StatTile value={String(manual)} label="Entered by hand" hint="the rest post themselves" variant="bento" />
          <StatTile value={String(reversed)} label="Reversed" hint="each linked to its mirror" variant="bento" />
        </View>
      </BentoCard>

      {compact && detail ? (
        <>
          <Pressable onPress={() => setSelectedId(null)} role="button" style={styles.back}>
            <Text style={styles.backText}>‹ All entries</Text>
          </Pressable>
          {detail}
        </>
      ) : detail ? (
        <View style={styles.split}>
          <View style={styles.listSide}>{list}</View>
          <View style={styles.detailSide}>{detail}</View>
        </View>
      ) : (
        list
      )}

      <Caveat tone="context">
        A reversal keeps the date of the entry it undoes, so deleting last month’s sale today files its reversal under last
        month. Switch to “Written in range” to see everything recorded in this range, whatever its date.
      </Caveat>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 14 },
  tiles: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  tableBody: { paddingHorizontal: 10 },
  split: { flexDirection: 'row', gap: 14, alignItems: 'flex-start' },
  listSide: { flex: 1, minWidth: 0 },
  detailSide: { width: 440 },
  back: { alignSelf: 'flex-start' },
  backText: { fontSize: 13, fontWeight: '800', color: theme.bentoAccentSolid },
});
