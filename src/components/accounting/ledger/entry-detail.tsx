import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Colors } from '@/constants/theme';
import { useAuth } from '@/hooks/use-auth';
import { formatCents } from '@/lib/currency';
import { expenseCategoryLabel } from '@/lib/expense-reporting';
import {
  getJournalEntry,
  listAccounts,
  listEntrySources,
  listMemberNames,
  type EntryExpenseSummary,
  type EntrySaleSummary,
} from '@/lib/ledger';
import { detailLines, plainWords, postingHow, readableDescription, referencedIds, type SourceNames } from '@/lib/ledger-detail';
import { entryDateLabel } from '@/lib/ledger-view';
import { methodLabel } from '@/lib/payment-methods';
import { toDateColumn } from '@/lib/period';
import type { Account, ExpenseCategory, JournalEntry } from '@/types/models';

const theme = Colors.light;

// Everything the detail panes need that is not on the entry row itself: the
// chart of accounts, who is who, and what the sales and expenses behind a page
// of entries say about themselves. Loaded once per list, not per click, so
// walking down the list with the pane open costs nothing.
export type LedgerContext = {
  accounts: Map<string, Account>;
  sales: Map<string, EntrySaleSummary>;
  expenses: Map<string, EntryExpenseSummary>;
  names: SourceNames;
  personName: (userId: string | null | undefined) => string;
};

export function useLedgerContext(entries: Pick<JournalEntry, 'description'>[]): LedgerContext {
  const { shop, session, profile } = useAuth();
  const [accounts, setAccounts] = useState<Map<string, Account>>(new Map());
  const [members, setMembers] = useState<Map<string, string>>(new Map());
  const [sales, setSales] = useState<Map<string, EntrySaleSummary>>(new Map());
  const [expenses, setExpenses] = useState<Map<string, EntryExpenseSummary>>(new Map());

  useEffect(() => {
    if (!shop) return;
    listAccounts(shop.id).then((rows) => setAccounts(new Map(rows.map((a) => [a.id, a])))).catch(() => {});
    // A reader without roster access gets no names back, and "A team member"
    // stands in -- a failed lookup must not blank the pane it decorates.
    listMemberNames(shop.id).then(setMembers).catch(() => {});
  }, [shop]);

  const idsKey = useMemo(() => {
    const saleIds = [...new Set(entries.flatMap((e) => referencedIds(e.description, 'sale')))];
    const expenseIds = [...new Set(entries.flatMap((e) => referencedIds(e.description, 'expense')))];
    return JSON.stringify([saleIds, expenseIds]);
  }, [entries]);

  useEffect(() => {
    const [saleIds, expenseIds] = JSON.parse(idsKey) as [string[], string[]];
    if (saleIds.length === 0 && expenseIds.length === 0) return;
    listEntrySources(saleIds, expenseIds)
      .then((found) => { setSales(found.sales); setExpenses(found.expenses); })
      .catch(() => {});
  }, [idsKey]);

  const names = useMemo<SourceNames>(() => ({
    sales: new Map([...sales].map(([id, s]) => [id, s.customerName ?? 'walk-in'])),
    expenses: new Map([...expenses].map(([id, e]) => [id, e.note || expenseCategoryLabel(e.category as ExpenseCategory)])),
  }), [sales, expenses]);

  const myId = session?.user?.id ?? null;
  const personName = useCallback((userId: string | null | undefined) => {
    if (!userId) return 'System';
    if (userId === myId && profile?.fullName) return profile.fullName;
    return members.get(userId) ?? 'A team member';
  }, [members, myId, profile]);

  return useMemo(() => ({ accounts, sales, expenses, names, personName }), [accounts, sales, expenses, names, personName]);
}

function statusPill(entry: JournalEntry): { label: string; wash: string; ink: string } {
  if (entry.reference?.endsWith('R')) return { label: '↺ Reversal', wash: theme.bentoSoft, ink: theme.bentoInk2 };
  if (entry.status === 'reversed') return { label: '✕ Reversed', wash: theme.bentoDownWash, ink: theme.bentoDownInk };
  if (entry.status === 'draft') return { label: 'Draft', wash: theme.bentoSoft, ink: theme.bentoMuted };
  return { label: '✓ Posted', wash: theme.bentoUpWash, ink: theme.bentoUpInk };
}

function when(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function EntryDetail({
  entry: initialEntry,
  context,
  onClose,
  embedded = false,
}: {
  entry: JournalEntry;
  context: LedgerContext;
  onClose?: () => void;
  // Inside the audit pane, which has its own close.
  embedded?: boolean;
}) {
  // The pane can step to the entry's mirror and back without leaving the list.
  // Callers key this by entry id, so picking another row starts it afresh.
  const [entry, setEntry] = useState(initialEntry);
  const [history, setHistory] = useState<JournalEntry[]>([]);

  const openLinked = async () => {
    if (!entry.reversesEntryId) return;
    const linked = await getJournalEntry(entry.reversesEntryId).catch(() => null);
    if (linked) { setHistory((h) => [...h, entry]); setEntry(linked); }
  };
  const back = () => {
    const previous = history[history.length - 1];
    if (previous) { setHistory((h) => h.slice(0, -1)); setEntry(previous); }
  };

  const { lines, debitCents, creditCents } = detailLines(entry, context.accounts);
  const words = plainWords(entry, context.accounts);
  const how = postingHow(entry);
  const pill = statusPill(entry);
  const saleId = referencedIds(entry.description, 'sale')[0];
  const expenseId = referencedIds(entry.description, 'expense')[0];
  const sale = saleId ? context.sales.get(saleId) : undefined;
  const expense = expenseId ? context.expenses.get(expenseId) : undefined;
  const writtenDay = toDateColumn(entry.createdAt);
  const writtenLater = writtenDay > entry.entryDate;
  const isReversal = Boolean(entry.reference?.endsWith('R'));

  return (
    <View>
      {history.length > 0 && (
        <Pressable onPress={back} role="button" style={styles.backLink}>
          <Text style={styles.linkText}>‹ Back to {history[history.length - 1].reference ?? 'the entry'}</Text>
        </Pressable>
      )}

      <View style={styles.head}>
          <View style={{ flex: 1 }}>
            <View style={styles.refRow}>
              <Text style={styles.ref}>{entry.reference ?? 'Entry'}</Text>
              <View style={[styles.pill, { backgroundColor: pill.wash }]}><Text style={[styles.pillText, { color: pill.ink }]}>{pill.label}</Text></View>
            </View>
            <Text style={styles.title}>{readableDescription(entry.description, context.names)}</Text>
            <Text style={styles.sub}>Dated {entryDateLabel(entry.entryDate)} · written {when(entry.createdAt)}</Text>
          </View>
          {onClose && !embedded && (
            <Pressable onPress={onClose} role="button" accessibilityLabel="Close" style={styles.close}>
              <Text style={styles.closeText}>✕</Text>
            </Pressable>
          )}
      </View>

      {(saleId || expenseId) && (
        <>
          <Text style={styles.label}>WHAT CAUSED IT</Text>
          <View style={styles.source}>
            {sale ? (
              <>
                <Text style={styles.sourceTitle}>
                  Sale{sale.customerName ? ` to ${sale.customerName}` : ''} · {sale.itemCount} item{sale.itemCount === 1 ? '' : 's'} · {formatCents(sale.totalCents)}
                </Text>
                <Text style={styles.sourceMeta}>
                  {sale.paymentMethod === 'unpaid' ? 'Left on account' : `Paid by ${methodLabel(sale.paymentMethod as never)}`}
                  {sale.settledAt === null ? ' · not fully paid yet' : ''}
                  {sale.cashierName ? ` · rung up by ${sale.cashierName}` : ''}
                </Text>
              </>
            ) : expense ? (
              <>
                <Text style={styles.sourceTitle}>Expense · {expenseCategoryLabel(expense.category as ExpenseCategory)} · {formatCents(expense.amountCents)}</Text>
                <Text style={styles.sourceMeta}>{[expense.vendorName, expense.note].filter(Boolean).join(' · ') || 'No note'}</Text>
              </>
            ) : (
              <>
                <Text style={styles.sourceTitle}>{saleId ? 'This sale' : 'This expense'} no longer exists</Text>
                <Text style={styles.sourceMeta}>
                  {isReversal || entry.status === 'reversed'
                    ? 'It was deleted, and the entry was reversed so the books no longer count it.'
                    : 'It may have been deleted, or you may not have access to it.'}
                </Text>
              </>
            )}
          </View>
        </>
      )}

      <Text style={styles.label}>LINES</Text>
      <View style={styles.lineHead}>
        <Text style={[styles.th, { flex: 1 }]}>ACCOUNT</Text>
        <Text style={[styles.th, styles.num]}>DEBIT</Text>
        <Text style={[styles.th, styles.num]}>CREDIT</Text>
      </View>
      {lines.map((line) => (
        <View key={line.id} style={styles.lineRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.account}><Text style={styles.code}>{line.code} </Text>{line.accountName}</Text>
            {line.memo ? <Text style={styles.memo}>{line.memo}</Text> : null}
          </View>
          <Text style={[styles.amount, styles.num, !line.debitCents && styles.dim]}>{line.debitCents ? formatCents(line.debitCents) : '—'}</Text>
          <Text style={[styles.amount, styles.num, !line.creditCents && styles.dim]}>{line.creditCents ? formatCents(line.creditCents) : '—'}</Text>
        </View>
      ))}
      <View style={styles.totalRow}>
        <Text style={[styles.balanced, { flex: 1 }, debitCents !== creditCents && { color: theme.bentoLoss }]}>
          {debitCents === creditCents ? '✓ Balanced' : '✕ Does not balance'}
        </Text>
        <Text style={[styles.total, styles.num]}>{formatCents(debitCents)}</Text>
        <Text style={[styles.total, styles.num]}>{formatCents(creditCents)}</Text>
      </View>

      {words.length > 0 && (
        <>
          <Text style={styles.label}>IN PLAIN WORDS</Text>
          <View style={styles.words}>
            {words.map((sentence, i) => (
              <Text key={i} style={styles.sentence}>• {sentence}</Text>
            ))}
          </View>
        </>
      )}

      <Text style={styles.label}>{embedded ? 'DATES' : 'HOW AND WHO'}</Text>
      <View style={styles.kv}>
        {/* The audit pane above already says who and how. */}
        {!embedded && (
          <>
            <View style={styles.kvRow}>
              <Text style={styles.k}>How</Text>
              <Text style={styles.v}>{how.automatic ? 'Automatic · ' : 'By hand · '}{how.text}</Text>
            </View>
            <View style={styles.kvRow}>
              <Text style={styles.k}>Who</Text>
              <Text style={styles.v}>{context.personName(entry.createdBy)}</Text>
            </View>
          </>
        )}
        <View style={styles.kvRow}>
          <Text style={styles.k}>Dated</Text>
          <Text style={styles.v}>{entryDateLabel(entry.entryDate)}{isReversal ? ' — the original’s own date' : ''}</Text>
        </View>
        <View style={styles.kvRow}>
          <Text style={styles.k}>Written</Text>
          <Text style={styles.v}>{when(entry.createdAt)}</Text>
        </View>
      </View>
      {writtenLater && (
        <Text style={styles.warn}>
          Written after its date. A Journals range that starts after {entryDateLabel(entry.entryDate)} won’t list it unless you switch to “Written”.
        </Text>
      )}

      {entry.reversesEntryId && (
        <Pressable onPress={openLinked} role="button" style={styles.linkButton}>
          <Text style={styles.linkButtonText}>{isReversal ? 'Open the entry it undoes' : 'Open its reversal'} ›</Text>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', gap: 10, alignItems: 'flex-start' },
  refRow: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  ref: { fontSize: 12, fontWeight: '800', letterSpacing: 0.4, color: theme.bentoMuted },
  pill: { borderRadius: 999, paddingHorizontal: 9, paddingVertical: 2 },
  pillText: { fontSize: 11, fontWeight: '800' },
  title: { fontSize: 19, fontWeight: '800', letterSpacing: -0.5, color: theme.bentoInk, marginTop: 4 },
  sub: { fontSize: 12.5, color: theme.bentoMuted, marginTop: 2 },
  close: { width: 30, height: 30, borderRadius: 15, backgroundColor: theme.bentoSoft, alignItems: 'center', justifyContent: 'center' },
  closeText: { fontSize: 12, fontWeight: '800', color: theme.bentoMuted },
  backLink: { marginBottom: 10 },
  linkText: { fontSize: 12.5, fontWeight: '800', color: theme.bentoAccentSolid },
  label: { fontSize: 10.5, fontWeight: '800', letterSpacing: 0.8, color: theme.bentoMuted2, marginTop: 18, marginBottom: 8 },
  source: { backgroundColor: theme.bentoSoft, borderRadius: 16, paddingHorizontal: 14, paddingVertical: 12, gap: 2 },
  sourceTitle: { fontSize: 13.5, fontWeight: '700', color: theme.bentoInk },
  sourceMeta: { fontSize: 12, color: theme.bentoMuted },
  lineHead: { flexDirection: 'row', paddingBottom: 5, borderBottomWidth: 1, borderBottomColor: theme.bentoRule },
  th: { fontSize: 10, fontWeight: '800', letterSpacing: 0.6, color: theme.bentoMuted2 },
  num: { width: 78, textAlign: 'right' },
  lineRow: { flexDirection: 'row', paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: theme.bentoLine, alignItems: 'flex-start' },
  account: { fontSize: 13, fontWeight: '700', color: theme.bentoInk },
  code: { color: theme.bentoMuted2 },
  memo: { fontSize: 11.5, color: theme.bentoMuted, marginTop: 1 },
  amount: { fontSize: 13, color: theme.bentoInk, fontVariant: ['tabular-nums'] },
  dim: { color: theme.bentoMuted3 },
  totalRow: { flexDirection: 'row', paddingTop: 8, alignItems: 'center' },
  balanced: { fontSize: 11.5, fontWeight: '800', color: theme.bentoProfit },
  total: { fontSize: 13, fontWeight: '800', color: theme.bentoInk, fontVariant: ['tabular-nums'] },
  words: { gap: 5 },
  sentence: { fontSize: 13, color: theme.bentoInk2, lineHeight: 19 },
  kv: { gap: 6 },
  kvRow: { flexDirection: 'row', gap: 12 },
  k: { width: 64, fontSize: 13, color: theme.bentoMuted },
  v: { flex: 1, fontSize: 13, fontWeight: '600', color: theme.bentoInk2 },
  warn: { fontSize: 12, fontWeight: '700', color: theme.bentoWarn, marginTop: 10, lineHeight: 17 },
  linkButton: { alignSelf: 'flex-start', marginTop: 16, backgroundColor: theme.bentoSoft, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8 },
  linkButtonText: { fontSize: 12.5, fontWeight: '800', color: theme.bentoInk },
});
