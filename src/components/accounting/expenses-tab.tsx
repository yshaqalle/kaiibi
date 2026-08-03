import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';

import { ExpenseEditorModal } from '@/components/accounting/expense-editor-modal';
import { formatRangeLabel } from '@/components/accounting/transactions-tab';
import { ExportMenu } from '@/components/export-menu';
import type { DateRange } from '@/components/range-selector';
import { StatTile } from '@/components/stat-tile';
import { useAuth } from '@/hooks/use-auth';
import type { CsvColumn } from '@/lib/csv';
import { formatAccountingCents } from '@/lib/currency';
import {
  EXPENSE_CATEGORIES,
  expenseCategoryLabel,
  isOperatingExpense,
  operatingExpenseCents,
  totalExpenseCents,
} from '@/lib/expense-reporting';
import { createExpense, deleteExpense, listExpensesInRange, updateExpense } from '@/lib/expenses';
import { methodLabel } from '@/lib/payment-methods';
import type { Expense, ExpenseCategory } from '@/types/models';

const EXPENSE_EXPORT_COLUMNS: CsvColumn<Expense>[] = [
  { header: 'Date', value: (e) => e.occurredOn },
  { header: 'Category', value: (e) => expenseCategoryLabel(e.category) },
  { header: 'Vendor', value: (e) => e.vendorName ?? '' },
  { header: 'Payment Method', value: (e) => methodLabel(e.paymentMethod) },
  { header: 'Note', value: (e) => e.note ?? '' },
  { header: 'Amount', value: (e) => (e.amountCents / 100).toFixed(2) },
];

// Same column-width approach as the transactions table -- plain objects, not
// StyleSheet entries, because RN's Text/View style types disagree on some
// properties (see product-table-row.tsx).
const colDate = { flexBasis: '16%', flexGrow: 0, flexShrink: 0 } as const;
const colCategory = { flexBasis: '22%', flexGrow: 0, flexShrink: 0 } as const;
const colVendor = { flexBasis: '22%', flexGrow: 0, flexShrink: 0 } as const;
const colMethod = { flexBasis: '14%', flexGrow: 0, flexShrink: 0 } as const;
const colAmount = { flexBasis: '16%', flexGrow: 0, flexShrink: 0 } as const;

function extractErrorMessage(err: unknown): string {
  if (err && typeof err === 'object' && 'message' in err && typeof (err as { message: unknown }).message === 'string') {
    return (err as { message: string }).message;
  }
  return 'Something went wrong.';
}

export function ExpensesTab({ dateRange }: { dateRange: DateRange }) {
  const { shop, can } = useAuth();
  const { width } = useWindowDimensions();
  const compact = width < 860;
  const canManage = can('expenses.manage');

  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [categoryFilter, setCategoryFilter] = useState<ExpenseCategory | 'all'>('all');
  const [editing, setEditing] = useState<Expense | 'new' | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const { since, until } = dateRange;

  const reload = useCallback(async () => {
    if (!shop) return;
    setLoading(true);
    try {
      setExpenses(await listExpensesInRange(shop.id, since, until));
      setError(null);
    } catch (err) {
      setError(extractErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [shop, since, until]);

  useEffect(() => { reload(); }, [reload]);

  const filtered = useMemo(
    () => (categoryFilter === 'all' ? expenses : expenses.filter((e) => e.category === categoryFilter)),
    [expenses, categoryFilter]
  );

  // Totals stay on the whole range, not the category filter -- the filter is a
  // way to find rows, and having the headline number move with it would make
  // "what did we spend" quietly ambiguous.
  const totalCents = totalExpenseCents(expenses);
  const operatingCents = operatingExpenseCents(expenses);
  const nonOperatingCents = totalCents - operatingCents;
  const rangeLabel = formatRangeLabel(dateRange);

  // Only categories actually present, so the filter row doesn't list eleven
  // options for a shop with three kinds of expense.
  const presentCategories = useMemo(() => {
    const present = new Set(expenses.map((e) => e.category));
    return EXPENSE_CATEGORIES.filter((c) => present.has(c.key));
  }, [expenses]);

  const close = () => setEditing(null);

  return (
    <View>
      <View style={styles.header}>
        <View style={styles.headerActions}>
          <ExportMenu rows={filtered} columns={EXPENSE_EXPORT_COLUMNS} title="Expenses" subtitle={rangeLabel} filenamePrefix="expenses" />
          {canManage && (
            <Pressable onPress={() => setEditing('new')} style={styles.newButton}>
              <Text style={styles.newButtonText}>+ New expense</Text>
            </Pressable>
          )}
        </View>
      </View>

      <View style={styles.metricRow}>
        <StatTile value={formatAccountingCents(totalCents)} label={`Spent · ${rangeLabel}`} />
        <StatTile value={formatAccountingCents(operatingCents)} label="Operating expenses" />
        {nonOperatingCents > 0 && (
          <StatTile value={formatAccountingCents(nonOperatingCents)} label="Stock & owner draws" />
        )}
      </View>

      {presentCategories.length > 1 && (
        <View style={styles.filterRow}>
          <Pressable onPress={() => setCategoryFilter('all')} style={[styles.filterChip, categoryFilter === 'all' && styles.filterChipActive]}>
            <Text style={[styles.filterChipText, categoryFilter === 'all' && styles.filterChipTextActive]}>All</Text>
          </Pressable>
          {presentCategories.map((option) => {
            const active = option.key === categoryFilter;
            return (
              <Pressable key={option.key} onPress={() => setCategoryFilter(option.key)} style={[styles.filterChip, active && styles.filterChipActive]}>
                <Text style={[styles.filterChipText, active && styles.filterChipTextActive]}>{option.label}</Text>
              </Pressable>
            );
          })}
        </View>
      )}

      {error && <Text style={styles.error}>{error}</Text>}

      {loading ? (
        <Text style={styles.empty}>Loading…</Text>
      ) : filtered.length === 0 ? (
        <Text style={styles.empty}>
          {expenses.length === 0
            ? 'No expenses logged in this range yet.'
            : 'No expenses in this category for this range.'}
        </Text>
      ) : compact ? (
        <View style={styles.cardList}>
          {filtered.map((expense) => (
            <Pressable
              key={expense.id}
              onPress={() => canManage && setEditing(expense)}
              style={styles.card}
            >
              <View style={styles.cardTop}>
                <View style={styles.cardMain}>
                  <Text style={styles.cardTitle}>{expenseCategoryLabel(expense.category)}</Text>
                  <Text style={styles.cardMeta} numberOfLines={1}>
                    {[expense.vendorName, expense.occurredOn, methodLabel(expense.paymentMethod)].filter(Boolean).join(' · ')}
                  </Text>
                  {expense.note ? <Text style={styles.cardNote} numberOfLines={1}>{expense.note}</Text> : null}
                </View>
                <Text style={styles.cardAmount}>{formatAccountingCents(expense.amountCents)}</Text>
              </View>
            </Pressable>
          ))}
        </View>
      ) : (
        <View>
          <View style={styles.tableHeaderRow}>
            <Text style={[styles.headerLabel, colDate]}>DATE</Text>
            <Text style={[styles.headerLabel, colCategory]}>CATEGORY</Text>
            <Text style={[styles.headerLabel, colVendor]}>VENDOR</Text>
            <Text style={[styles.headerLabel, colMethod]}>PAID WITH</Text>
            <Text style={[styles.headerLabel, styles.alignRight, colAmount]}>AMOUNT</Text>
          </View>
          {filtered.map((expense) => (
            <Pressable
              key={expense.id}
              onPress={() => canManage && setEditing(expense)}
              style={styles.tableRow}
            >
              <Text style={[styles.cellText, styles.muted, colDate]} numberOfLines={1}>{expense.occurredOn}</Text>
              <View style={colCategory}>
                <Text style={styles.cellText} numberOfLines={1}>{expenseCategoryLabel(expense.category)}</Text>
                {!isOperatingExpense(expense.category) && <Text style={styles.tagText}>not an operating cost</Text>}
              </View>
              <Text style={[styles.cellText, styles.muted, colVendor]} numberOfLines={1}>{expense.vendorName ?? '—'}</Text>
              <Text style={[styles.cellText, colMethod]} numberOfLines={1}>{methodLabel(expense.paymentMethod)}</Text>
              <Text style={[styles.cellText, styles.price, styles.alignRight, colAmount]} numberOfLines={1}>
                {formatAccountingCents(expense.amountCents)}
              </Text>
            </Pressable>
          ))}
        </View>
      )}

      {editing !== null && shop && (
        <ExpenseEditorModal
          key={editing === 'new' ? 'new' : editing.id}
          shopId={shop.id}
          expense={editing === 'new' ? null : editing}
          onClose={close}
          onSave={async (input) => {
            if (editing !== 'new') await updateExpense(editing.id, input);
            else await createExpense(shop.id, input);
            await reload();
            close();
          }}
          onDelete={
            editing !== 'new'
              ? async () => {
                  await deleteExpense(editing.id);
                  await reload();
                  close();
                }
              : undefined
          }
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end', alignItems: 'center', gap: 10, marginBottom: 16 },
  headerActions: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  newButton: { backgroundColor: '#111111', borderRadius: 10, paddingHorizontal: 12, paddingVertical: 9 },
  newButtonText: { color: '#FFFFFF', fontWeight: '800', fontSize: 11 },
  metricRow: { flexDirection: 'row', gap: 10, marginBottom: 18, flexWrap: 'wrap' },

  filterRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 16 },
  filterChip: { borderWidth: 1, borderColor: '#ECECEC', paddingVertical: 6, paddingHorizontal: 12, borderRadius: 999 },
  filterChipActive: { backgroundColor: '#F2F2F2', borderColor: '#F2F2F2' },
  filterChipText: { fontSize: 11.5, fontWeight: '700', color: '#777777' },
  filterChipTextActive: { color: '#111111' },

  tableHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#ECECEC',
    borderTopLeftRadius: 14,
    borderTopRightRadius: 14,
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 10,
  },
  headerLabel: { fontSize: 10, fontWeight: '900', color: '#555555', letterSpacing: 0.6 },
  tableRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 14,
    gap: 10,
    borderWidth: 1,
    borderTopWidth: 0,
    borderColor: '#ECECEC',
  },
  cellText: { fontSize: 13, color: '#111111' },
  muted: { color: '#999999' },
  price: { fontWeight: '800' },
  alignRight: { textAlign: 'right' },
  tagText: { fontSize: 10, color: '#B5793A', fontWeight: '700', marginTop: 2 },

  cardList: { gap: 10 },
  card: { backgroundColor: '#FFFFFF', borderRadius: 14, borderWidth: 1, borderColor: '#ECECEC', padding: 14 },
  cardTop: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  cardMain: { flex: 1, minWidth: 0 },
  cardTitle: { fontSize: 13, fontWeight: '700', color: '#111111' },
  cardMeta: { fontSize: 11, color: '#999999', marginTop: 3 },
  cardNote: { fontSize: 11, color: '#777777', marginTop: 3 },
  cardAmount: { fontSize: 14, fontWeight: '800', color: '#111111' },

  empty: { color: '#999999', fontSize: 13, marginTop: 20, textAlign: 'center' },
  error: { color: '#C0392B', fontSize: 12, fontWeight: '700', marginBottom: 12 },
});
