import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { ReportExport } from '@/components/accounting/reports/report-export';
import { useTabRefresh, type HeaderActionsSetter, type RefreshSetter } from '@/components/accounting/use-header-actions';
import { BentoCard } from '@/components/ui/bento-card';
import { Caveat } from '@/components/ui/caveat';
import { DataTable, NameCell, ValueCell, type Column } from '@/components/ui/data-table';
import { useAuth } from '@/hooks/use-auth';
import { useRefreshOnFocus } from '@/hooks/use-refresh-on-focus';
import { listAuditLog, type AuditRow } from '@/lib/ledger';

// "journal_entries" is what the column holds and not what a person calls it.
const SUBJECT_LABELS: Record<string, string> = {
  journal_entries: 'Journal entry',
  journal_lines: 'Entry line',
  accounts: 'Account',
  accounting_periods: 'Period',
};

const ACTION_LABELS: Record<AuditRow['action'], string> = {
  insert: 'Created',
  update: 'Changed',
  delete: 'Deleted',
};

// The one field a reader actually wants out of the before/after blobs. Showing
// the whole jsonb would be a wall nobody reads; showing nothing would make the
// log a list of timestamps.
function describe(row: AuditRow): string | undefined {
  const after = row.after ?? {};
  const before = row.before ?? {};
  if (typeof after.reference === 'string') return after.reference;
  if (typeof after.status === 'string' && typeof before.status === 'string' && after.status !== before.status) {
    return `${before.status} → ${after.status}`;
  }
  if (typeof after.code === 'string') return `${after.code} ${after.name ?? ''}`.trim();
  return undefined;
}

const COLUMNS: Column<AuditRow>[] = [
  {
    key: 'when',
    header: 'When',
    width: 132,
    render: (row) => (
      <ValueCell
        value={new Date(row.createdAt).toLocaleString(undefined, {
          day: 'numeric',
          month: 'short',
          hour: '2-digit',
          minute: '2-digit',
        })}
        tone="muted"
      />
    ),
    text: (row) =>
      new Date(row.createdAt).toLocaleString(undefined, {
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      }),
  },
  {
    key: 'what',
    header: 'What',
    render: (row) => (
      <NameCell
        title={`${ACTION_LABELS[row.action]} ${(SUBJECT_LABELS[row.subjectTable] ?? row.subjectTable).toLowerCase()}`}
        meta={describe(row)}
      />
    ),
    // Title and detail joined: the log's whole value is what changed, and the
    // detail is the half that says which record.
    text: (row) => {
      const what = `${ACTION_LABELS[row.action]} ${(SUBJECT_LABELS[row.subjectTable] ?? row.subjectTable).toLowerCase()}`;
      const detail = describe(row);
      return detail ? `${what} · ${detail}` : what;
    },
  },
  {
    key: 'who',
    header: 'Who',
    width: 110,
    // Null actor is a real answer, not missing data: a migration or a
    // maintenance script wrote it, and saying "System" is more honest than a
    // blank cell that reads as a bug.
    render: (row) => <ValueCell value={row.actorId ? 'A person' : 'System'} tone="muted" />,
    text: (row) => (row.actorId ? 'A person' : 'System'),
  },
];

export function AuditLogView({ setRefresh, setHeaderActions }: { setRefresh: RefreshSetter; setHeaderActions: HeaderActionsSetter }) {
  const { shop } = useAuth();
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [loaded, setLoaded] = useState(false);

  const reload = useCallback(async () => {
    if (!shop) return;
    setRows(await listAuditLog(shop.id));
    setLoaded(true);
  }, [shop]);

  useEffect(() => { reload(); }, [reload]);
  useRefreshOnFocus(reload);
  useTabRefresh(setRefresh, reload);

  return (
    <View style={styles.wrap}>
      <ReportExport
        setHeaderActions={setHeaderActions}
        rows={rows}
        columns={COLUMNS}
        title="Audit Log"
        // A position read at an instant, so the file is stamped with the
        // moment rather than a window it never honoured.
        rangeLabel={null}
        locationFilter={null}
        filenamePrefix="audit-log"
      />
      <BentoCard title="Activity" scope="Last 200" bodyStyle={styles.tableBody}>
        <DataTable
          columns={COLUMNS}
          rows={rows}
          keyExtractor={(row) => row.id}
          emptyLabel={loaded ? 'Nothing has happened in the books yet.' : 'Loading…'}
        />
      </BentoCard>

      <Caveat tone="context">
        Written by the database, not the app — so a change made through any route lands here. There is no way to edit or
        delete a row, including for the shop owner.
      </Caveat>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 14 },
  tableBody: { paddingHorizontal: 10 },
});
