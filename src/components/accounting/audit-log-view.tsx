import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { formatRangeLabel } from '@/components/accounting/transactions-tab';
import { useHeaderActions, type HeaderActionsSetter } from '@/components/accounting/use-header-actions';
import { ExportMenu } from '@/components/export-menu';
import type { DateRange } from '@/components/range-selector';
import { BentoCard } from '@/components/ui/bento-card';
import { DataTable, NameCell, ValueCell, type Column } from '@/components/ui/data-table';
import { Colors } from '@/constants/theme';
import { useAuth } from '@/hooks/use-auth';
import {
  AUDIT_ACTION_LABELS,
  AUDIT_ENTITY_LABELS,
  auditColumnLabel,
  describeChanges,
  isRemoval,
  listAuditLog,
} from '@/lib/audit-log';
import type { CsvColumn } from '@/lib/csv';
import { formatAccountingCents } from '@/lib/currency';
import type { AuditEntity, AuditLogEntry } from '@/types/models';

const theme = Colors.light;

// The audit log: who changed the books, when, and what it was worth.
//
// Read-only, and there is nothing here to make it otherwise -- the table has no
// insert, update or delete policy for anyone. What the screen has to do instead
// is make an append-only list SCANNABLE, because a log nobody can find anything
// in is only technically a log.
//
// So: the amount is signed, and a deletion is negative. That one decision is
// what makes the list answerable. "Someone took $2,000 out of the books last
// week" is the question people bring here, and a column of positive figures
// makes a $2,000 deletion look exactly like a $2,000 entry.

const ENTITY_FILTERS: { key: AuditEntity | 'all'; label: string }[] = [
  { key: 'all', label: 'Everything' },
  { key: 'expense', label: 'Expenses' },
  { key: 'invoice', label: 'Bills' },
  { key: 'invoice_payment', label: 'Bill payments' },
  { key: 'journal_entry', label: 'Journal' },
  { key: 'fixed_asset', label: 'Assets' },
  { key: 'cash_account', label: 'Cash' },
  { key: 'cash_transfer', label: 'Transfers' },
  { key: 'ledger_account', label: 'Accounts' },
];

const EXPORT_COLUMNS: CsvColumn<AuditLogEntry>[] = [
  { header: 'When', value: (e) => e.occurredAt },
  { header: 'Who', value: (e) => e.actorName ?? '' },
  { header: 'Did', value: (e) => AUDIT_ACTION_LABELS[e.action] },
  { header: 'To', value: (e) => AUDIT_ENTITY_LABELS[e.entity] },
  { header: 'What', value: (e) => e.summary },
  { header: 'Amount', value: (e) => (e.amountCents === null ? '' : (e.amountCents / 100).toFixed(2)) },
  {
    header: 'Changes',
    value: (e) =>
      describeChanges(e.changes)
        .map((change) => `${auditColumnLabel(change.column)}: ${String(change.from ?? '—')} → ${String(change.to ?? '—')}`)
        .join('; '),
  },
];

function extractErrorMessage(err: unknown): string {
  if (err && typeof err === 'object' && 'message' in err && typeof (err as { message: unknown }).message === 'string') {
    return (err as { message: string }).message;
  }
  return 'Something went wrong.';
}

function whenLabel(iso: string): string {
  const at = new Date(iso);
  return `${at.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} · ${at.toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  })}`;
}

export function AuditLogView({
  dateRange,
  revision,
  setHeaderActions,
}: {
  dateRange: DateRange;
  revision: number;
  setHeaderActions: HeaderActionsSetter;
}) {
  const { shop } = useAuth();
  const [entries, setEntries] = useState<AuditLogEntry[]>([]);
  const [entityFilter, setEntityFilter] = useState<AuditEntity | 'all'>('all');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { since, until } = dateRange;

  const reload = useCallback(async () => {
    if (!shop) return;
    try {
      // Fetched unfiltered and narrowed on the client. The filter row only
      // offers entities that are actually present, which needs the whole set
      // to work out -- and re-fetching on every chip tap for a list this size
      // buys nothing.
      setEntries(await listAuditLog(shop.id, { since, until }));
      setError(null);
    } catch (err) {
      setError(extractErrorMessage(err));
    } finally {
      setLoaded(true);
    }
  }, [shop, since, until]);

  useEffect(() => {
    reload();
  }, [reload, revision]);

  const present = useMemo(() => {
    const kinds = new Set(entries.map((entry) => entry.entity));
    return ENTITY_FILTERS.filter((option) => option.key === 'all' || kinds.has(option.key));
  }, [entries]);

  const visible = useMemo(
    () => (entityFilter === 'all' ? entries : entries.filter((entry) => entry.entity === entityFilter)),
    [entries, entityFilter]
  );

  const columns: Column<AuditLogEntry>[] = useMemo(
    () => [
      {
        key: 'what',
        header: 'What happened',
        render: (entry) => (
          <NameCell
            title={`${AUDIT_ACTION_LABELS[entry.action]} · ${entry.summary}`}
            meta={[AUDIT_ENTITY_LABELS[entry.entity], entry.actorName ?? 'someone'].join(' · ')}
          />
        ),
      },
      {
        key: 'when',
        header: 'When',
        numeric: true,
        width: 130,
        render: (entry) => <ValueCell value={whenLabel(entry.occurredAt)} tone="muted" />,
      },
      {
        key: 'amount',
        header: 'Amount',
        numeric: true,
        width: 120,
        render: (entry) =>
          entry.amountCents === null ? (
            <ValueCell value="—" tone="muted" />
          ) : (
            <ValueCell
              value={formatAccountingCents(entry.amountCents)}
              // The sign carries the meaning; the tone only reinforces it.
              // Colour alone is never the signal — see the bento notes on
              // bentoProfit/bentoLoss.
              tone={isRemoval(entry.action) ? 'danger' : 'default'}
              strong
            />
          ),
      },
    ],
    []
  );

  const rangeLabel = formatRangeLabel(dateRange);

  useHeaderActions(
    setHeaderActions,
    <ExportMenu rows={visible} columns={EXPORT_COLUMNS} title="Audit log" subtitle={rangeLabel} filenamePrefix="audit-log" />,
    [visible, rangeLabel]
  );

  const openEntry = expanded ? visible.find((entry) => entry.id === expanded) : null;
  const openChanges = openEntry ? describeChanges(openEntry.changes) : [];

  return (
    <BentoCard title="Audit log" scope={rangeLabel} bodyStyle={styles.tableBody}>
      {error ? <Text style={styles.error}>{error}</Text> : null}

      {present.length > 2 && (
        <View style={styles.filterRow}>
          {present.map((option) => {
            const active = option.key === entityFilter;
            return (
              <Pressable
                key={option.key}
                onPress={() => setEntityFilter(option.key)}
                style={[styles.chip, active && styles.chipActive]}
              >
                <Text style={[styles.chipText, active && styles.chipTextActive]}>{option.label}</Text>
              </Pressable>
            );
          })}
        </View>
      )}

      <DataTable
        columns={columns}
        rows={visible}
        keyExtractor={(entry) => entry.id}
        // An edit's detail is the columns that moved, which is far too much to
        // put in a row and exactly what someone opening the log wants once they
        // have found the entry.
        onRowPress={(entry) => setExpanded(expanded === entry.id ? null : entry.id)}
        emptyLabel={loaded ? 'Nothing changed in this range.' : 'Loading…'}
        minWidth={680}
      />

      {openEntry && openChanges.length > 0 ? (
        <View style={styles.detail}>
          <Text style={styles.detailTitle}>{`What changed · ${openEntry.summary}`}</Text>
          {openChanges.map((change) => (
            <View key={change.column} style={styles.detailRow}>
              <Text style={styles.detailLabel}>{auditColumnLabel(change.column)}</Text>
              <Text style={styles.detailValue} numberOfLines={2}>
                {`${change.from === null || change.from === undefined ? '—' : String(change.from)}  →  ${
                  change.to === null || change.to === undefined ? '—' : String(change.to)
                }`}
              </Text>
            </View>
          ))}
        </View>
      ) : null}

      {openEntry && openChanges.length === 0 ? (
        <Text style={styles.footnote}>
          {openEntry.action === 'delete'
            ? 'Deleted. The row itself is gone — this entry is what is left of it.'
            : 'No field-level detail was recorded for this one.'}
        </Text>
      ) : null}

      <Text style={styles.footnote}>
        Entries are written by the database, not by the app, and nothing can edit or remove one — including an owner.
        Dates are when the change was made, not the period it belongs to.
      </Text>
    </BentoCard>
  );
}

const styles = StyleSheet.create({
  tableBody: { paddingHorizontal: 10 },
  filterRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 12, paddingHorizontal: 8 },
  chip: { borderWidth: 1, borderColor: theme.bentoLine, paddingVertical: 6, paddingHorizontal: 12, borderRadius: 999 },
  chipActive: { backgroundColor: theme.bentoSoft, borderColor: theme.bentoSoft },
  chipText: { fontSize: 11.5, fontWeight: '700', color: theme.bentoMuted },
  chipTextActive: { color: theme.bentoInk },

  detail: { marginTop: 14, marginHorizontal: 8, backgroundColor: theme.bentoSoft, borderRadius: 14, padding: 14 },
  detailTitle: { fontSize: 12, fontWeight: '800', color: theme.bentoInk, marginBottom: 8 },
  detailRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, paddingVertical: 6, borderTopWidth: 1, borderTopColor: theme.bentoLine },
  detailLabel: { flexBasis: 140, flexGrow: 0, fontSize: 12, fontWeight: '700', color: theme.bentoMuted },
  detailValue: { flex: 1, minWidth: 0, fontSize: 12, color: theme.bentoInk },

  footnote: { fontSize: 11, color: theme.bentoMuted, marginTop: 14, paddingHorizontal: 8, lineHeight: 16 },
  error: { color: theme.bentoLoss, fontSize: 12, fontWeight: '700', marginBottom: 10, paddingHorizontal: 8 },
});
