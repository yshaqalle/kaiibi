import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { JournalEntryModal } from '@/components/accounting/journal-entry-modal';
import { formatRangeLabel } from '@/components/accounting/transactions-tab';
import { useHeaderActions, type HeaderActionsSetter } from '@/components/accounting/use-header-actions';
import { ExportMenu } from '@/components/export-menu';
import type { DateRange } from '@/components/range-selector';
import { BentoCard } from '@/components/ui/bento-card';
import { Colors } from '@/constants/theme';
import { useAuth } from '@/hooks/use-auth';
import type { CsvColumn } from '@/lib/csv';
import { formatAccountingCents } from '@/lib/currency';
import { listJournalEntries, reverseJournalEntry } from '@/lib/ledger';
import { toDateColumn } from '@/lib/period';
import { postableAccounts } from '@/lib/chart-of-accounts';
import type { JournalEntry, LedgerAccount } from '@/types/models';

const theme = Colors.light;

// The journals list: every hand-posted entry, newest first, each one opened out
// so its lines are visible without a tap.
//
// Entries are shown EXPANDED rather than as a collapsed list of totals, and
// that is the whole layout decision. A journal entry's total tells a reader
// almost nothing -- "$400" could be rent accrued, a loan drawn or a correction
// -- and the accounts on either side are the entry. A list of dates and totals
// would make every one of them look identical.

const EXPORT_COLUMNS: CsvColumn<{ entry: JournalEntry; line: JournalEntry['lines'][number] }>[] = [
  { header: 'Entry', value: (r) => `JE-${r.entry.entryNo}` },
  { header: 'Date', value: (r) => r.entry.entryDate },
  { header: 'Memo', value: (r) => r.entry.memo ?? '' },
  { header: 'Reference', value: (r) => r.entry.reference ?? '' },
  { header: 'Account', value: (r) => `${r.line.accountCode ?? ''} ${r.line.accountName ?? ''}`.trim() },
  { header: 'Line memo', value: (r) => r.line.memo ?? '' },
  { header: 'Debit', value: (r) => (r.line.debitCents ? (r.line.debitCents / 100).toFixed(2) : '') },
  { header: 'Credit', value: (r) => (r.line.creditCents ? (r.line.creditCents / 100).toFixed(2) : '') },
];

function extractErrorMessage(err: unknown): string {
  if (err && typeof err === 'object' && 'message' in err && typeof (err as { message: unknown }).message === 'string') {
    return (err as { message: string }).message;
  }
  return 'Something went wrong.';
}

export function JournalEntriesView({
  accounts,
  canManage,
  dateRange,
  locationFilter,
  revision,
  onChanged,
  setHeaderActions,
}: {
  accounts: LedgerAccount[];
  canManage: boolean;
  dateRange: DateRange;
  locationFilter: string | null;
  /** Bumped by the Ledger tab when something else changed the books. */
  revision: number;
  onChanged: () => Promise<void> | void;
  setHeaderActions: HeaderActionsSetter;
}) {
  const { shop } = useAuth();
  const [entries, setEntries] = useState<JournalEntry[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [composing, setComposing] = useState(false);
  const [reversing, setReversing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { since, until } = dateRange;

  const reload = useCallback(async () => {
    if (!shop) return;
    try {
      setEntries(await listJournalEntries(shop.id, { since, until }));
      setError(null);
    } catch (err) {
      setError(extractErrorMessage(err));
    } finally {
      setLoaded(true);
    }
  }, [shop, since, until]);

  useEffect(() => {
    reload();
    // `revision` on purpose: posting from anywhere in the Ledger tab has to
    // land here, and the fetch is cheap enough to repeat on a signal that
    // usually means something did change.
  }, [reload, revision]);

  // Business-wide entries stay visible in a per-store view, unlike costs.
  // An accrual booked against no store is still part of that store's picture
  // in the only sense a journal has -- see location-reporting.ts for the rule
  // this follows.
  const visible = useMemo(
    () => (locationFilter ? entries.filter((e) => e.locationId === locationFilter || e.locationId === null) : entries),
    [entries, locationFilter]
  );

  const exportRows = useMemo(
    () => visible.flatMap((entry) => entry.lines.map((line) => ({ entry, line }))),
    [visible]
  );

  const rangeLabel = formatRangeLabel(dateRange);

  useHeaderActions(
    setHeaderActions,
    <>
      <ExportMenu rows={exportRows} columns={EXPORT_COLUMNS} title="Journal" subtitle={rangeLabel} filenamePrefix="journal" />
      {canManage && (
        <Pressable onPress={() => setComposing(true)} style={styles.newButton}>
          <Text style={styles.newButtonText}>+ New entry</Text>
        </Pressable>
      )}
    </>,
    [exportRows, rangeLabel, canManage]
  );

  const reverse = async (entry: JournalEntry) => {
    setReversing(entry.id);
    setError(null);
    try {
      // Dated TODAY, not on the entry's own date. A reversal backdated into
      // the period it corrects makes the mistake disappear from a report
      // somebody has already read -- which is the one thing reversing is meant
      // to avoid.
      await reverseJournalEntry(entry.id, toDateColumn(new Date()));
      await reload();
      await onChanged();
    } catch (err) {
      setError(extractErrorMessage(err));
    } finally {
      setReversing(null);
    }
  };

  return (
    <>
      <BentoCard title="Journal" scope={rangeLabel}>
        {error ? <Text style={styles.error}>{error}</Text> : null}

        {!loaded ? (
          <Text style={styles.empty}>Loading…</Text>
        ) : visible.length === 0 ? (
          <Text style={styles.empty}>
            Nothing posted by hand in this range. Sales, bills, expenses and cash all report themselves — the journal
            is for what has no other home: capital, loans, accruals and corrections.
          </Text>
        ) : (
          <View style={styles.entryList}>
            {visible.map((entry) => {
              const total = entry.lines.reduce((sum, line) => sum + line.debitCents, 0);
              const reversed = Boolean(entry.reversedById);
              return (
                <View key={entry.id} style={[styles.entry, reversed && styles.entryReversed]}>
                  <View style={styles.entryHead}>
                    <View style={styles.entryHeadMain}>
                      <Text style={styles.entryNo}>{`JE-${entry.entryNo}`}</Text>
                      <Text style={styles.entryMemo} numberOfLines={2}>
                        {entry.memo ?? 'No memo'}
                      </Text>
                      <Text style={styles.entryMeta} numberOfLines={1}>
                        {[
                          entry.entryDate,
                          entry.reference,
                          entry.source === 'reversal' ? 'a reversal' : null,
                          reversed ? 'reversed' : null,
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </Text>
                    </View>
                    <View style={styles.entryHeadSide}>
                      <Text style={styles.entryTotal}>{formatAccountingCents(total)}</Text>
                      {/* Offered only where it means something: a reversal
                          cannot be reversed (the RPC refuses it) and an entry
                          already reversed has nothing left to undo. */}
                      {canManage && !reversed && entry.source !== 'reversal' && (
                        <Pressable onPress={() => reverse(entry)} disabled={reversing === entry.id}>
                          <Text style={styles.reverseText}>{reversing === entry.id ? 'Reversing…' : 'Reverse'}</Text>
                        </Pressable>
                      )}
                    </View>
                  </View>

                  <View style={styles.lines}>
                    {entry.lines.map((line) => (
                      <View key={line.id} style={styles.line}>
                        <View style={styles.lineName}>
                          <Text style={styles.lineAccount} numberOfLines={1}>
                            {`${line.accountCode ?? ''} ${line.accountName ?? 'Account'}`.trim()}
                          </Text>
                          {line.memo ? <Text style={styles.lineMemo} numberOfLines={1}>{line.memo}</Text> : null}
                        </View>
                        <Text style={styles.lineAmount}>
                          {line.debitCents > 0 ? formatAccountingCents(line.debitCents) : ''}
                        </Text>
                        <Text style={styles.lineAmount}>
                          {line.creditCents > 0 ? formatAccountingCents(line.creditCents) : ''}
                        </Text>
                      </View>
                    ))}
                    <View style={styles.lineHeadings}>
                      <View style={styles.lineName} />
                      <Text style={styles.lineHeading}>DEBIT</Text>
                      <Text style={styles.lineHeading}>CREDIT</Text>
                    </View>
                  </View>
                </View>
              );
            })}
          </View>
        )}
      </BentoCard>

      {composing && shop && (
        <JournalEntryModal
          accounts={postableAccounts(accounts)}
          onClose={() => setComposing(false)}
          onPosted={async () => {
            await reload();
            await onChanged();
            setComposing(false);
          }}
        />
      )}
    </>
  );
}

const styles = StyleSheet.create({
  newButton: { backgroundColor: theme.bentoInk, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 9 },
  newButtonText: { color: theme.bentoSurface, fontWeight: '800', fontSize: 11 },

  entryList: { gap: 12 },
  entry: { backgroundColor: theme.bentoSoft, borderRadius: 14, padding: 14 },
  // A reversed entry is history, not news. Dimmed rather than hidden: the
  // whole reason a reversal exists instead of an edit is that both halves stay
  // readable.
  entryReversed: { opacity: 0.55 },
  entryHead: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  entryHeadMain: { flex: 1, minWidth: 0 },
  entryHeadSide: { alignItems: 'flex-end', gap: 4 },
  entryNo: { fontSize: 10.5, fontWeight: '900', letterSpacing: 0.7, color: theme.bentoMuted },
  entryMemo: { fontSize: 13.5, fontWeight: '700', color: theme.bentoInk, marginTop: 2 },
  entryMeta: { fontSize: 11, color: theme.bentoMuted, marginTop: 3 },
  entryTotal: { fontSize: 14, fontWeight: '800', color: theme.bentoInk, fontVariant: ['tabular-nums'] },
  reverseText: { fontSize: 11, fontWeight: '700', color: theme.bentoLoss },

  lines: { marginTop: 12, gap: 2 },
  line: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 6, borderTopWidth: 1, borderTopColor: theme.bentoLine },
  lineName: { flex: 1, minWidth: 0 },
  lineAccount: { fontSize: 12.5, color: theme.bentoInk },
  lineMemo: { fontSize: 10.5, color: theme.bentoMuted, marginTop: 1 },
  lineAmount: { width: 92, textAlign: 'right', fontSize: 12.5, fontWeight: '700', color: theme.bentoInk, fontVariant: ['tabular-nums'] },
  // Under the lines, not above them: the columns are obvious from the figures
  // themselves, and a heading row above every entry in a list of entries reads
  // as clutter. This is a legend, so it sits where a legend sits.
  lineHeadings: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingTop: 4 },
  lineHeading: { width: 92, textAlign: 'right', fontSize: 9, fontWeight: '900', letterSpacing: 0.6, color: theme.bentoMuted2 },

  empty: { color: theme.bentoMuted, fontSize: 13, marginTop: 12, textAlign: 'center', lineHeight: 19 },
  error: { color: theme.bentoLoss, fontSize: 12, fontWeight: '700', marginBottom: 10 },
});
