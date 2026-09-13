import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';

import { EntryDetail, useLedgerContext, type LedgerContext } from '@/components/accounting/ledger/entry-detail';
import { ReportExport } from '@/components/accounting/reports/report-export';
import { useTabRefresh, type HeaderActionsSetter, type RefreshSetter } from '@/components/accounting/use-header-actions';
import { BentoCard } from '@/components/ui/bento-card';
import { Caveat } from '@/components/ui/caveat';
import { DataTable, NameCell, ValueCell, type Column } from '@/components/ui/data-table';
import { Colors } from '@/constants/theme';
import { useAuth } from '@/hooks/use-auth';
import { useRefreshOnFocus } from '@/hooks/use-refresh-on-focus';
import { getJournalEntry, listAuditLog } from '@/lib/ledger';
import { eventMeta, eventTitle, fieldChanges, groupAuditEvents, postingHow, type AuditEvent } from '@/lib/ledger-detail';
import type { JournalEntry } from '@/types/models';

const theme = Colors.light;

// Rows, not events: a posting writes an entry row plus one per line, so 1000
// rows is a couple of hundred events -- the "Last 200" this card has always
// promised, now counted in things that happened rather than in lines.
const FETCH_ROWS = 1000;
const SHOW_EVENTS = 200;

function whenLabel(iso: string, withYear = false): string {
  return new Date(iso).toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    ...(withYear ? { year: 'numeric' as const, second: '2-digit' as const } : {}),
    hour: '2-digit',
    minute: '2-digit',
  });
}

// How the change came about, in the reader's words. An entry carries the
// source that posted it; everything else is either a person in a settings
// screen or, with no actor, the app itself.
function howLabel(event: AuditEvent): string {
  const { row } = event;
  const record = (row.after ?? row.before ?? {}) as Record<string, unknown>;
  if (row.subjectTable === 'journal_entries' && typeof record.source === 'string') {
    if (row.action === 'update' && (row.before ?? {}).status !== (row.after ?? {}).status) {
      return 'Marked reversed when its mirror entry was written';
    }
    return postingHow({
      source: record.source,
      description: String(record.description ?? ''),
      reference: typeof record.reference === 'string' ? record.reference : null,
      reversesEntryId: null,
    }).text;
  }
  if (row.subjectTable === 'accounting_periods' && row.action === 'insert') return 'Opened on demand by the first posting dated in that month';
  if (!row.actorId) return 'By the app itself — an update or maintenance, not a person';
  return 'Changed on the Accounting screens';
}

function columnsFor(context: LedgerContext): Column<AuditEvent>[] {
  return [
    {
      key: 'when',
      header: 'When',
      width: 132,
      render: (event) => <ValueCell value={whenLabel(event.row.createdAt)} tone="muted" />,
      text: (event) => whenLabel(event.row.createdAt),
    },
    {
      key: 'what',
      header: 'What',
      render: (event) => <NameCell title={eventTitle(event)} meta={eventMeta(event)} />,
      text: (event) => {
        const meta = eventMeta(event);
        return meta ? `${eventTitle(event)} · ${meta}` : eventTitle(event);
      },
    },
    {
      key: 'who',
      header: 'Who',
      width: 130,
      // Null actor is a real answer, not missing data: a migration or a
      // maintenance script wrote it, and "System" is more honest than a blank.
      render: (event) => <ValueCell value={context.personName(event.row.actorId)} tone="muted" />,
      text: (event) => context.personName(event.row.actorId),
    },
  ];
}

function EventDetail({ event, context, onClose }: { event: AuditEvent; context: LedgerContext; onClose: () => void }) {
  const { row } = event;
  const isEntry = row.subjectTable === 'journal_entries';
  const [entry, setEntry] = useState<JournalEntry | null>(null);
  const [showRaw, setShowRaw] = useState(false);

  // Keyed by event, so a different row mounts afresh rather than resetting here.
  useEffect(() => {
    const entryId = isEntry ? row.subjectId : row.subjectTable === 'journal_lines' ? String((row.after ?? row.before ?? {}).entry_id ?? '') : '';
    if (!entryId) return;
    getJournalEntry(entryId).then(setEntry).catch(() => setEntry(null));
  }, [row, isEntry]);

  // An entry's own fields are already the whole entry pane below; repeating
  // them as a field list says everything twice. Updates still show the diff,
  // because what CHANGED is the point of an update.
  const changes = isEntry && row.action === 'insert' ? [] : fieldChanges(row);

  return (
    <View>
      <View style={styles.head}>
        <View style={{ flex: 1 }}>
          <Text style={styles.eyebrow}>AUDIT EVENT</Text>
          <Text style={styles.title}>{eventTitle(event)}</Text>
          <Text style={styles.sub}>{whenLabel(row.createdAt, true)}</Text>
        </View>
        <Pressable onPress={onClose} role="button" accessibilityLabel="Close" style={styles.close}>
          <Text style={styles.closeText}>✕</Text>
        </Pressable>
      </View>

      <Text style={styles.label}>WHO AND HOW</Text>
      <View style={styles.kv}>
        <View style={styles.kvRow}><Text style={styles.k}>Person</Text><Text style={styles.v}>{context.personName(row.actorId)}</Text></View>
        <View style={styles.kvRow}><Text style={styles.k}>How</Text><Text style={styles.v}>{howLabel(event)}</Text></View>
      </View>

      {changes.length > 0 && (
        <>
          <Text style={styles.label}>{row.action === 'update' ? 'WHAT CHANGED' : row.action === 'insert' ? 'WHAT WAS WRITTEN' : 'WHAT WAS REMOVED'}</Text>
          {changes.map((change) => (
            <View key={change.field} style={styles.diffRow}>
              <Text style={styles.diffField}>{change.field}</Text>
              <Text style={styles.diffValue}>
                {row.action === 'update' ? (
                  <>
                    <Text style={styles.was}>{change.before ?? 'none'}</Text>
                    <Text style={styles.arrow}>{'  →  '}</Text>
                    <Text style={styles.now}>{change.after ?? 'none'}</Text>
                  </>
                ) : (
                  <Text style={styles.now}>{(row.action === 'delete' ? change.before : change.after) ?? '—'}</Text>
                )}
              </Text>
            </View>
          ))}
        </>
      )}

      {entry && (
        <>
          <Text style={styles.label}>THE ENTRY</Text>
          <EntryDetail key={entry.id} entry={entry} context={context} embedded />
        </>
      )}

      <Pressable onPress={() => setShowRaw((v) => !v)} role="button" style={styles.rawButton}>
        <Text style={styles.rawButtonText}>{showRaw ? 'Hide raw record' : 'Show raw record'}</Text>
      </Pressable>
      {showRaw && (
        <Text style={styles.raw} selectable>
          {JSON.stringify({ action: row.action, table: row.subjectTable, before: row.before, after: row.after, lines: event.lines.map((l) => l.after) }, null, 2)}
        </Text>
      )}
    </View>
  );
}

export function AuditLogView({ setRefresh, setHeaderActions }: { setRefresh: RefreshSetter; setHeaderActions: HeaderActionsSetter }) {
  const { shop } = useAuth();
  const { width } = useWindowDimensions();
  const compact = width < 860;
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!shop) return;
    setEvents(groupAuditEvents(await listAuditLog(shop.id, FETCH_ROWS)).slice(0, SHOW_EVENTS));
    setLoaded(true);
  }, [shop]);

  useEffect(() => { reload(); }, [reload]);
  useRefreshOnFocus(reload);
  useTabRefresh(setRefresh, reload);

  // The entries' descriptions are what name the sales and expenses behind them.
  const describedEntries = useMemo(
    () => events
      .filter((e) => e.row.subjectTable === 'journal_entries')
      .map((e) => ({ description: String((e.row.after ?? e.row.before ?? {}).description ?? '') })),
    [events]
  );
  const context = useLedgerContext(describedEntries);
  const columns = useMemo(() => columnsFor(context), [context]);
  const selected = events.find((e) => e.key === selectedKey) ?? null;

  const detail = selected ? (
    <BentoCard>
      <EventDetail key={selected.key} event={selected} context={context} onClose={() => setSelectedKey(null)} />
    </BentoCard>
  ) : null;

  const list = (
    <BentoCard title="Activity" scope={`Last ${SHOW_EVENTS}`} bodyStyle={styles.tableBody}>
      <DataTable
        columns={columns}
        rows={events}
        keyExtractor={(event) => event.key}
        onRowPress={(event) => setSelectedKey(event.key)}
        selectedKey={selectedKey}
        emptyLabel={loaded ? 'Nothing has happened in the books yet.' : 'Loading…'}
      />
    </BentoCard>
  );

  return (
    <View style={styles.wrap}>
      <ReportExport
        setHeaderActions={setHeaderActions}
        rows={events}
        columns={columns}
        title="Audit Log"
        // A position read at an instant, so the file is stamped with the
        // moment rather than a window it never honoured.
        rangeLabel={null}
        locationFilter={null}
        filenamePrefix="audit-log"
      />

      {compact && detail ? (
        <>
          <Pressable onPress={() => setSelectedKey(null)} role="button" style={styles.back}>
            <Text style={styles.backText}>‹ All activity</Text>
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
        Written by the database, not the app — so a change made through any route lands here. There is no way to edit or
        delete a row, including for the shop owner. An entry’s lines are folded into the entry; “Show raw record” has them.
      </Caveat>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 14 },
  tableBody: { paddingHorizontal: 10 },
  split: { flexDirection: 'row', gap: 14, alignItems: 'flex-start' },
  listSide: { flex: 1, minWidth: 0 },
  detailSide: { width: 460 },
  back: { alignSelf: 'flex-start' },
  backText: { fontSize: 13, fontWeight: '800', color: theme.bentoAccentSolid },
  head: { flexDirection: 'row', gap: 10, alignItems: 'flex-start' },
  eyebrow: { fontSize: 11, fontWeight: '800', letterSpacing: 0.6, color: theme.bentoMuted },
  title: { fontSize: 19, fontWeight: '800', letterSpacing: -0.5, color: theme.bentoInk, marginTop: 2 },
  sub: { fontSize: 12.5, color: theme.bentoMuted, marginTop: 2 },
  close: { width: 30, height: 30, borderRadius: 15, backgroundColor: theme.bentoSoft, alignItems: 'center', justifyContent: 'center' },
  closeText: { fontSize: 12, fontWeight: '800', color: theme.bentoMuted },
  label: { fontSize: 10.5, fontWeight: '800', letterSpacing: 0.8, color: theme.bentoMuted2, marginTop: 18, marginBottom: 8 },
  kv: { gap: 6 },
  kvRow: { flexDirection: 'row', gap: 12 },
  k: { width: 64, fontSize: 13, color: theme.bentoMuted },
  v: { flex: 1, fontSize: 13, fontWeight: '600', color: theme.bentoInk2 },
  diffRow: { flexDirection: 'row', gap: 12, paddingVertical: 7, borderBottomWidth: 1, borderBottomColor: theme.bentoLine },
  diffField: { width: 96, fontSize: 12.5, color: theme.bentoMuted },
  diffValue: { flex: 1, fontSize: 12.5 },
  was: { color: theme.bentoMuted, textDecorationLine: 'line-through' },
  arrow: { color: theme.bentoMuted2 },
  now: { color: theme.bentoInk, fontWeight: '700' },
  rawButton: { alignSelf: 'flex-start', marginTop: 16, backgroundColor: theme.bentoSoft, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8 },
  rawButtonText: { fontSize: 12.5, fontWeight: '800', color: theme.bentoInk },
  raw: { marginTop: 10, fontSize: 11, color: theme.bentoInk2, fontFamily: 'monospace', backgroundColor: theme.bentoSoft, borderRadius: 12, padding: 12 },
});
