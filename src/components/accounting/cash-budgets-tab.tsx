import { useCallback, useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { RecurringBillModal } from '@/components/accounting/recurring-bill-modal';
import { useHeaderActions, type HeaderActionsSetter } from '@/components/accounting/use-header-actions';
import { Badge } from '@/components/badge';
import { BudgetBar } from '@/components/budget-bar';
import type { DateRange } from '@/components/range-selector';
import { StatTile } from '@/components/stat-tile';
import { useAuth } from '@/hooks/use-auth';
import {
  BILL_FREQUENCY_LABELS,
  billDueState,
  budgetRows,
  CASH_ACCOUNT_TYPE_LABELS,
  monthlyBillCommitmentCents,
  totalCashCents,
  type BudgetRow,
} from '@/lib/cash-budget-reporting';
import {
  createCashAccount,
  deleteCashAccount,
  deleteRecurringBill,
  listBudgets,
  listCashAccounts,
  listRecurringBills,
  logRecurringBill,
  updateCashAccount,
  upsertBudget,
  createRecurringBill,
  updateRecurringBill,
} from '@/lib/cash-budgets';
import { formatAccountingCents, toCents } from '@/lib/currency';
import { expenseCategoryLabel } from '@/lib/expense-reporting';
import { listExpensesInRange } from '@/lib/expenses';
import type { Budget, CashAccount, Expense, NewRecurringBillInput, RecurringBill } from '@/types/models';

function extractErrorMessage(err: unknown): string {
  if (err && typeof err === 'object' && 'message' in err && typeof (err as { message: unknown }).message === 'string') {
    return (err as { message: string }).message;
  }
  return 'Something went wrong.';
}

export function CashBudgetsTab({
  dateRange,
  setHeaderActions,
}: {
  dateRange: DateRange;
  setHeaderActions: HeaderActionsSetter;
}) {
  const { shop, can } = useAuth();
  const allowed = can('budgets.manage');
  const canLogBills = can('expenses.manage');

  const [accounts, setAccounts] = useState<CashAccount[]>([]);
  const [bills, setBills] = useState<RecurringBill[]>([]);
  const [budgets, setBudgets] = useState<Budget[]>([]);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [editingBill, setEditingBill] = useState<RecurringBill | 'new' | null>(null);
  const [addingAccount, setAddingAccount] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const { since, until } = dateRange;

  const reload = useCallback(async () => {
    if (!shop || !allowed) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const [accountRows, billRows, budgetRowsData, expenseRows] = await Promise.all([
        listCashAccounts(shop.id),
        listRecurringBills(shop.id),
        listBudgets(shop.id),
        listExpensesInRange(shop.id, since, until),
      ]);
      setAccounts(accountRows);
      setBills(billRows);
      setBudgets(budgetRowsData);
      setExpenses(expenseRows);
      setError(null);
    } catch (err) {
      setError(extractErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [shop, allowed, since, until]);

  useEffect(() => { reload(); }, [reload]);

  if (!allowed) {
    return (
      <Text style={styles.empty}>
        Cash and budgets need the budgets permission. Ask an owner to grant it in Settings → Roles.
      </Text>
    );
  }

  const cashTotal = totalCashCents(accounts);
  const monthlyCommitment = monthlyBillCommitmentCents(bills);
  const rows = budgetRows(expenses, budgets);

  return (
    <View>
      <CashBudgetsHeaderActions
        onNewBill={() => setEditingBill('new')}
        setHeaderActions={setHeaderActions}
      />

      {error && <Text style={styles.error}>{error}</Text>}

      <View style={styles.metricRow}>
        <StatTile value={formatAccountingCents(cashTotal)} label="Cash on hand" />
        <StatTile value={formatAccountingCents(monthlyCommitment)} label="Committed each month" />
      </View>

      {/* Worth saying out loud: this is the number that catches shops out.
          Stock purchases drain the bank without being an expense, so profit
          and cash routinely disagree. */}
      <Text style={styles.caption}>
        Cash on hand is what you last counted, not a calculated figure — update it when you check. Profit and cash aren&apos;t
        the same thing: buying stock takes money out now but only becomes a cost when it sells.
      </Text>

      {loading ? (
        <Text style={styles.empty}>Loading…</Text>
      ) : (
        <>
          {/* --- Cash on hand: a snapshot, not driven by the date range --- */}
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>Cash on hand</Text>
            <Pressable onPress={() => setAddingAccount(true)} style={styles.smallButton}>
              <Text style={styles.smallButtonText}>+ Account</Text>
            </Pressable>
          </View>
          <View style={styles.card}>
            {accounts.length === 0 && !addingAccount ? (
              <Text style={styles.sectionEmpty}>No accounts yet — add your cash drawer, bank, or a mobile wallet.</Text>
            ) : (
              accounts.map((account) => (
                <CashAccountRow
                  key={account.id}
                  account={account}
                  onSaveBalance={async (balanceCents) => {
                    await updateCashAccount(account.id, { balanceCents });
                    await reload();
                  }}
                  onDelete={async () => {
                    await deleteCashAccount(account.id);
                    await reload();
                  }}
                />
              ))
            )}
            {addingAccount && shop && (
              <NewCashAccountRow
                onCancel={() => setAddingAccount(false)}
                onCreate={async (name, balanceCents, accountType) => {
                  await createCashAccount(shop.id, { name, balanceCents, accountType, notes: null });
                  setAddingAccount(false);
                  await reload();
                }}
              />
            )}
          </View>

          {/* --- Recurring bills: forward-looking, also range-independent --- */}
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>Recurring bills</Text>
          </View>
          <View style={styles.card}>
            {bills.length === 0 ? (
              <Text style={styles.sectionEmpty}>No recurring bills set up yet.</Text>
            ) : (
              bills.map((bill) => {
                const state = billDueState(bill);
                return (
                  <View key={bill.id} style={styles.row}>
                    <View style={styles.rowMain}>
                      <Text style={styles.rowTitle}>{bill.name}</Text>
                      <Text style={styles.rowMeta}>
                        {expenseCategoryLabel(bill.category)} · {BILL_FREQUENCY_LABELS[bill.frequency]} · next due {bill.nextDueDate}
                      </Text>
                    </View>
                    <View style={styles.rowRight}>
                      {state !== 'upcoming' && (
                        <Badge
                          label={state === 'overdue' ? 'Overdue' : 'Due soon'}
                          tone={state === 'overdue' ? 'danger' : 'warning'}
                        />
                      )}
                      <Text style={styles.rowAmount}>{formatAccountingCents(bill.amountCents)}</Text>
                      {canLogBills && (
                        <Pressable
                          onPress={async () => {
                            setError(null);
                            try {
                              await logRecurringBill(bill.id);
                              await reload();
                            } catch (err) {
                              setError(extractErrorMessage(err));
                            }
                          }}
                          style={styles.logButton}
                        >
                          <Text style={styles.logButtonText}>Log</Text>
                        </Pressable>
                      )}
                      <Pressable onPress={() => setEditingBill(bill)} style={styles.smallButton}>
                        <Text style={styles.smallButtonText}>Edit</Text>
                      </Pressable>
                    </View>
                  </View>
                );
              })
            )}
            {bills.length > 0 && (
              <Text style={styles.sectionNote}>
                &ldquo;Log&rdquo; records the bill as an expense dated its due date and moves the next due date forward.
              </Text>
            )}
          </View>

          {/* --- Budget vs actual: the one section the date range drives --- */}
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>Budget vs. actual</Text>
          </View>
          <View style={styles.card}>
            {rows.length === 0 ? (
              <Text style={styles.sectionEmpty}>Nothing spent in this range, and no budgets set yet.</Text>
            ) : (
              rows.map((row) => (
                <BudgetRowView
                  key={row.category}
                  row={row}
                  onSaveLimit={async (limitCents) => {
                    if (!shop) return;
                    await upsertBudget(shop.id, row.category, limitCents);
                    await reload();
                  }}
                />
              ))
            )}
          </View>
        </>
      )}

      {editingBill !== null && shop && (
        <RecurringBillModal
          key={editingBill === 'new' ? 'new' : editingBill.id}
          shopId={shop.id}
          bill={editingBill === 'new' ? null : editingBill}
          onClose={() => setEditingBill(null)}
          onSave={async (input: NewRecurringBillInput) => {
            if (editingBill !== 'new') await updateRecurringBill(editingBill.id, input);
            else await createRecurringBill(shop.id, input);
            setEditingBill(null);
            await reload();
          }}
          onDelete={
            editingBill !== 'new'
              ? async () => {
                  await deleteRecurringBill(editingBill.id);
                  setEditingBill(null);
                  await reload();
                }
              : undefined
          }
        />
      )}
    </View>
  );
}

// A child so the hook isn't called after CashBudgetsTab's early permission
// return.
function CashBudgetsHeaderActions({
  onNewBill,
  setHeaderActions,
}: {
  onNewBill: () => void;
  setHeaderActions: HeaderActionsSetter;
}) {
  useHeaderActions(
    setHeaderActions,
    <Pressable onPress={onNewBill} style={styles.newButton}>
      <Text style={styles.newButtonText}>+ New bill</Text>
    </Pressable>,
    [onNewBill]
  );
  return null;
}

// Balance is edited in place and committed on blur, so checking the drawer and
// typing what's there is a two-tap job rather than a modal.
function CashAccountRow({
  account,
  onSaveBalance,
  onDelete,
}: {
  account: CashAccount;
  onSaveBalance: (balanceCents: number) => Promise<void>;
  onDelete: () => Promise<void>;
}) {
  const [draft, setDraft] = useState((account.balanceCents / 100).toFixed(2));
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const commit = () => {
    const cents = toCents(draft);
    if (cents !== account.balanceCents) onSaveBalance(cents);
  };

  return (
    <View style={styles.row}>
      <View style={styles.rowMain}>
        <Text style={styles.rowTitle}>{account.name}</Text>
        <Text style={styles.rowMeta}>
          {CASH_ACCOUNT_TYPE_LABELS[account.accountType]} · confirmed {new Date(account.balanceAsOf).toLocaleDateString()}
        </Text>
      </View>
      <View style={styles.rowRight}>
        <TextInput value={draft} onChangeText={setDraft} onBlur={commit} keyboardType="decimal-pad" style={styles.balanceInput} />
        {confirmingDelete ? (
          <>
            <Pressable onPress={onDelete}><Text style={styles.dangerText}>Confirm</Text></Pressable>
            <Pressable onPress={() => setConfirmingDelete(false)}><Text style={styles.mutedText}>Cancel</Text></Pressable>
          </>
        ) : (
          <Pressable onPress={() => setConfirmingDelete(true)}><Text style={styles.mutedText}>Remove</Text></Pressable>
        )}
      </View>
    </View>
  );
}

function NewCashAccountRow({
  onCancel,
  onCreate,
}: {
  onCancel: () => void;
  onCreate: (name: string, balanceCents: number, type: CashAccount['accountType']) => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [balance, setBalance] = useState('0.00');
  const [type, setType] = useState<CashAccount['accountType']>('cash');

  return (
    <View style={styles.newAccountRow}>
      <TextInput value={name} onChangeText={setName} placeholder="Account name" placeholderTextColor="#9B9B9B" style={styles.nameInput} />
      <View style={styles.chipRow}>
        {(Object.keys(CASH_ACCOUNT_TYPE_LABELS) as CashAccount['accountType'][]).map((key) => (
          <Pressable key={key} onPress={() => setType(key)} style={[styles.chip, type === key && styles.chipActive]}>
            <Text style={[styles.chipText, type === key && styles.chipTextActive]}>{CASH_ACCOUNT_TYPE_LABELS[key]}</Text>
          </Pressable>
        ))}
      </View>
      <View style={styles.newAccountActions}>
        <TextInput value={balance} onChangeText={setBalance} keyboardType="decimal-pad" style={styles.balanceInput} />
        <Pressable
          onPress={() => name.trim() && onCreate(name.trim(), toCents(balance), type)}
          disabled={!name.trim()}
          style={[styles.smallButtonDark, !name.trim() && styles.buttonDisabled]}
        >
          <Text style={styles.smallButtonDarkText}>Add</Text>
        </Pressable>
        <Pressable onPress={onCancel}><Text style={styles.mutedText}>Cancel</Text></Pressable>
      </View>
    </View>
  );
}

function BudgetRowView({ row, onSaveLimit }: { row: BudgetRow; onSaveLimit: (limitCents: number) => Promise<void> }) {
  const [draft, setDraft] = useState(row.limitCents !== null ? (row.limitCents / 100).toFixed(2) : '');

  const commit = () => {
    const trimmed = draft.trim();
    if (!trimmed) return;
    const cents = toCents(trimmed);
    if (cents !== row.limitCents) onSaveLimit(cents);
  };

  return (
    <View style={styles.budgetRow}>
      <View style={styles.budgetTop}>
        <Text style={styles.rowTitle}>{expenseCategoryLabel(row.category)}</Text>
        <View style={styles.budgetAmounts}>
          <Text style={styles.rowAmount}>{formatAccountingCents(row.spentCents)}</Text>
          <Text style={styles.budgetOf}>of</Text>
          <TextInput
            value={draft}
            onChangeText={setDraft}
            onBlur={commit}
            placeholder="Set"
            placeholderTextColor="#BBBBBB"
            keyboardType="decimal-pad"
            style={styles.limitInput}
          />
        </View>
      </View>
      <BudgetBar pctUsed={row.pctUsed} />
      {row.overBy > 0 && <Text style={styles.overText}>{formatAccountingCents(row.overBy)} over budget</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  metricRow: { flexDirection: 'row', gap: 10, marginBottom: 12, flexWrap: 'wrap' },
  caption: { fontSize: 11.5, color: '#999999', lineHeight: 17, marginBottom: 20 },

  sectionHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 10, marginBottom: 10 },
  sectionTitle: { fontSize: 15, fontWeight: '800', color: '#111111' },
  card: { borderWidth: 1, borderColor: '#ECECEC', borderRadius: 14, padding: 14, marginBottom: 12 },
  sectionEmpty: { fontSize: 12.5, color: '#999999', paddingVertical: 6 },
  sectionNote: { fontSize: 11, color: '#999999', lineHeight: 16, marginTop: 10 },

  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, paddingVertical: 11, borderBottomWidth: 1, borderBottomColor: '#F4F4F4', flexWrap: 'wrap' },
  rowMain: { flex: 1, minWidth: 140 },
  rowTitle: { fontSize: 13, fontWeight: '700', color: '#111111' },
  rowMeta: { fontSize: 11, color: '#999999', marginTop: 2 },
  rowRight: { flexDirection: 'row', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
  rowAmount: { fontSize: 13, fontWeight: '800', color: '#111111' },

  balanceInput: { backgroundColor: '#F2F2F2', borderRadius: 8, height: 36, width: 100, paddingHorizontal: 10, color: '#111111', textAlign: 'right', fontWeight: '700' },
  nameInput: { backgroundColor: '#F2F2F2', borderRadius: 8, height: 38, paddingHorizontal: 10, color: '#111111' },
  newAccountRow: { paddingVertical: 12, gap: 10 },
  newAccountActions: { flexDirection: 'row', alignItems: 'center', gap: 10 },

  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: { borderWidth: 1, borderColor: '#ECECEC', paddingVertical: 6, paddingHorizontal: 11, borderRadius: 999 },
  chipActive: { backgroundColor: '#111111', borderColor: '#111111' },
  chipText: { fontSize: 11.5, fontWeight: '700', color: '#777777' },
  chipTextActive: { color: '#FFFFFF' },

  budgetRow: { paddingVertical: 11, borderBottomWidth: 1, borderBottomColor: '#F4F4F4' },
  budgetTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 8 },
  budgetAmounts: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  budgetOf: { fontSize: 11, color: '#999999' },
  limitInput: { backgroundColor: '#F2F2F2', borderRadius: 8, height: 32, width: 84, paddingHorizontal: 8, color: '#111111', textAlign: 'right', fontWeight: '700' },
  overText: { fontSize: 11, color: '#C0392B', fontWeight: '700', marginTop: 6 },

  newButton: { backgroundColor: '#111111', borderRadius: 10, paddingHorizontal: 12, paddingVertical: 9 },
  newButtonText: { color: '#FFFFFF', fontWeight: '800', fontSize: 11 },
  smallButton: { paddingVertical: 7, paddingHorizontal: 12, borderRadius: 8, backgroundColor: '#F2F2F2' },
  smallButtonText: { fontSize: 11.5, fontWeight: '700', color: '#111111' },
  smallButtonDark: { paddingVertical: 8, paddingHorizontal: 14, borderRadius: 8, backgroundColor: '#111111' },
  smallButtonDarkText: { fontSize: 11.5, fontWeight: '800', color: '#FFFFFF' },
  logButton: { paddingVertical: 7, paddingHorizontal: 12, borderRadius: 8, backgroundColor: '#438254' },
  logButtonText: { fontSize: 11.5, fontWeight: '800', color: '#FFFFFF' },
  buttonDisabled: { backgroundColor: '#CCCCCC' },

  dangerText: { fontSize: 11.5, fontWeight: '700', color: '#C0392B' },
  mutedText: { fontSize: 11.5, fontWeight: '700', color: '#999999' },
  empty: { color: '#999999', fontSize: 13, marginTop: 20, textAlign: 'center', lineHeight: 19 },
  error: { color: '#C0392B', fontSize: 12, fontWeight: '700', marginBottom: 12 },
});
