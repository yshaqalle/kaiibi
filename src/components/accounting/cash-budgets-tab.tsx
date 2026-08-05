import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { RecurringBillModal } from '@/components/accounting/recurring-bill-modal';
import { useHeaderActions, type HeaderActionsSetter } from '@/components/accounting/use-header-actions';
import { Badge } from '@/components/badge';
import { BudgetBar } from '@/components/budget-bar';
import type { DateRange } from '@/components/range-selector';
import { StatTile } from '@/components/stat-tile';
import { useAuth } from '@/hooks/use-auth';
import { scopeToLocation } from '@/lib/location-reporting';
import {
  BILL_FREQUENCY_LABELS,
  billDueState,
  budgetRows,
  CASH_ACCOUNT_TYPE_LABELS,
  expectedChangeSinceCents,
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
import { formatAccountingCents, formatCompactCents, toCents } from '@/lib/currency';
import { expenseCategoryLabel } from '@/lib/expense-reporting';
import { listExpensesInRange } from '@/lib/expenses';
import { listPayrollRuns } from '@/lib/payroll';
import { accruedLaborCents } from '@/lib/payroll-reporting';
import { listStaff } from '@/lib/staff';
import { listShopTimeEntries } from '@/lib/time-entries';
import type { Budget, CashAccount, Expense, NewRecurringBillInput, RecurringBill } from '@/types/models';

function extractErrorMessage(err: unknown): string {
  if (err && typeof err === 'object' && 'message' in err && typeof (err as { message: unknown }).message === 'string') {
    return (err as { message: string }).message;
  }
  return 'Something went wrong.';
}

export function CashBudgetsTab({
  dateRange,
  locationFilter,
  setHeaderActions,
}: {
  dateRange: DateRange;
  /** Owned by the Accounting shell so it survives a tab switch. null = every store. */
  locationFilter: string | null;
  setHeaderActions: HeaderActionsSetter;
}) {
  const { shop, can, activeLocation } = useAuth();
  const allowed = can('budgets.manage');
  const canLogBills = can('expenses.manage');

  // null = the combined business view. Cash accounts always belong to a store
  // (a drawer sits on a counter), so scoping them is a straight filter; bills
  // and budgets can be business-wide, and scoping excludes those.
  const [accounts, setAccounts] = useState<CashAccount[]>([]);
  const [bills, setBills] = useState<RecurringBill[]>([]);
  const [budgets, setBudgets] = useState<Budget[]>([]);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [editingBill, setEditingBill] = useState<RecurringBill | 'new' | null>(null);
  const [addingAccount, setAddingAccount] = useState(false);
  // Expenses reaching back to the oldest confirmed balance, so each account's
  // "expected change since" covers the whole window rather than only whatever
  // range the screen happens to be showing.
  const [expensesSinceBalances, setExpensesSinceBalances] = useState<Expense[]>([]);
  const [accruedWagesCents, setAccruedWagesCents] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const { since, until } = dateRange;
  // Wages owed are money about to leave; showing cash without them reads
  // more comfortable than it is.
  const canSeeWagesOwed = can('people.payroll.manage') && can('expenses.manage');

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

      if (accountRows.length > 0) {
        const oldest = accountRows.reduce(
          (earliest, a) => (new Date(a.balanceAsOf) < earliest ? new Date(a.balanceAsOf) : earliest),
          new Date(accountRows[0].balanceAsOf)
        );
        setExpensesSinceBalances(await listExpensesInRange(shop.id, oldest));
      } else {
        setExpensesSinceBalances([]);
      }

      if (canSeeWagesOwed) {
        const rangeEnd = until ?? new Date();
        const [members, entries, runs] = await Promise.all([
          listStaff(shop.id),
          listShopTimeEntries(shop.id, { sinceIso: since.toISOString() }),
          listPayrollRuns(shop.id),
        ]);
        setAccruedWagesCents(accruedLaborCents(members, entries, since, rangeEnd, runs).accruedCents);
      } else {
        setAccruedWagesCents(0);
      }
      setError(null);
    } catch (err) {
      setError(extractErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [shop, allowed, since, until, canSeeWagesOwed]);

  useEffect(() => { reload(); }, [reload]);

  // Above the permission guard below on purpose: hooks must run in the same
  // order every render, and an early return between them is what
  // react-hooks/rules-of-hooks exists to catch.
  const accountsInScope = useMemo(
    () => (locationFilter === null ? accounts : accounts.filter((a) => a.locationId === locationFilter)),
    [accounts, locationFilter]
  );
  const billsInScope = useMemo(() => scopeToLocation(bills, locationFilter), [bills, locationFilter]);
  const budgetsInScope = useMemo(() => scopeToLocation(budgets, locationFilter), [budgets, locationFilter]);
  // Budget-vs-actual has to compare like with like: a store's budget against
  // that store's spend, not against every store's.
  const expensesInScope = useMemo(() => scopeToLocation(expenses, locationFilter), [expenses, locationFilter]);

  if (!allowed) {
    return (
      <Text style={styles.empty}>
        Cash and budgets need the budgets permission. Ask an owner to grant it in Settings → Roles.
      </Text>
    );
  }

  const cashTotal = totalCashCents(accountsInScope);
  const monthlyCommitment = monthlyBillCommitmentCents(billsInScope);
  const rows = budgetRows(expensesInScope, budgetsInScope);

  return (
    <View>
      <CashBudgetsHeaderActions
        onNewBill={() => setEditingBill('new')}
        setHeaderActions={setHeaderActions}
      />

      {error && <Text style={styles.error}>{error}</Text>}

      <View style={styles.metricRow}>
        <StatTile value={formatCompactCents(cashTotal)} label="Cash on hand" />
        <StatTile value={formatCompactCents(monthlyCommitment)} label="Committed each month" />
        {canSeeWagesOwed && accruedWagesCents > 0 && (
          <StatTile value={formatCompactCents(accruedWagesCents)} label="Wages owed" tone="warning" />
        )}
      </View>

      {/* Worth saying out loud: this is the number that catches shops out.
          Stock purchases drain the bank without being an expense, so profit
          and cash routinely disagree. */}
      <Text style={styles.caption}>
        Cash on hand is what you last counted, not a calculated figure — update it when you check. Profit and cash aren&apos;t
        the same thing: buying stock takes money out now but only becomes a cost when it sells.
        {canSeeWagesOwed && accruedWagesCents > 0
          ? ' Wages owed covers hours already worked that no pay run has settled — that money is still to go out.'
          : ''}
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
            {accountsInScope.length === 0 && !addingAccount ? (
              <Text style={styles.sectionEmpty}>No accounts yet — add your cash drawer, bank, or a mobile wallet.</Text>
            ) : (
              accountsInScope.map((account) => (
                <CashAccountRow
                  key={account.id}
                  account={account}
                  // Cash-method spending recorded since this balance was last
                  // confirmed. Advisory: it never rewrites the counted figure.
                  expectedChangeCents={
                    account.accountType === 'cash'
                      ? expectedChangeSinceCents(expensesSinceBalances, account.balanceAsOf)
                      : 0
                  }
                  onSaveBalance={async (balanceCents) => {
                    setError(null);
                    try {
                      await updateCashAccount(account.id, { balanceCents });
                      await reload();
                    } catch (err) {
                      setError(extractErrorMessage(err));
                    }
                  }}
                  onDelete={async () => {
                    setError(null);
                    try {
                      await deleteCashAccount(account.id);
                      await reload();
                    } catch (err) {
                      setError(extractErrorMessage(err));
                    }
                  }}
                />
              ))
            )}
            {addingAccount && shop && (
              <NewCashAccountRow
                // The tab-level banner sits above the fold once the account
                // list is long, so a failed Add read as nothing happening.
                // This puts the reason next to the button that caused it.
                error={error}
                onCancel={() => { setError(null); setAddingAccount(false); }}
                onCreate={async (name, balanceCents, accountType, notes) => {
                  // A drawer sits at a store, never at the business. The store
                  // being looked at is the one meant, so the filter wins; on the
                  // combined view there is nothing to read, so fall back to the
                  // store this device is set to.
                  const locationId = locationFilter ?? activeLocation?.id ?? null;
                  if (!locationId) {
                    setError('Pick a store before adding a cash account.');
                    return;
                  }
                  setError(null);
                  try {
                    await createCashAccount(shop.id, { name, balanceCents, accountType, notes, locationId });
                    setAddingAccount(false);
                    await reload();
                  } catch (err) {
                    // The form stays open, so what was typed survives the retry.
                    setError(extractErrorMessage(err));
                  }
                }}
              />
            )}
          </View>

          {/* --- Recurring bills: forward-looking, also range-independent --- */}
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>Recurring bills</Text>
          </View>
          <View style={styles.card}>
            {billsInScope.length === 0 ? (
              <Text style={styles.sectionEmpty}>No recurring bills set up yet.</Text>
            ) : (
              billsInScope.map((bill) => {
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
  expectedChangeCents,
  onSaveBalance,
  onDelete,
}: {
  account: CashAccount;
  expectedChangeCents: number;
  onSaveBalance: (balanceCents: number) => Promise<void>;
  onDelete: () => Promise<void>;
}) {
  const saved = (account.balanceCents / 100).toFixed(2);
  const [draft, setDraft] = useState(saved);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [saving, setSaving] = useState(false);
  // Committing on blur meant tapping away from a half-typed figure recorded it
  // as the counted balance. A count is a deliberate act, so it takes a
  // deliberate tap -- and until then the typed figure is only a draft.
  const dirty = toCents(draft) !== account.balanceCents;

  const save = async () => {
    if (!dirty || saving) return;
    setSaving(true);
    try {
      await onSaveBalance(toCents(draft));
    } finally {
      setSaving(false);
    }
  };

  return (
    <View style={styles.row}>
      <View style={styles.rowMain}>
        <Text style={styles.rowTitle}>{account.name}</Text>
        <Text style={styles.rowMeta}>
          {CASH_ACCOUNT_TYPE_LABELS[account.accountType]} · confirmed {new Date(account.balanceAsOf).toLocaleDateString()}
        </Text>
        {account.notes && <Text style={styles.rowMeta}>{account.notes}</Text>}
        {expectedChangeCents !== 0 && (
          <Text style={styles.rowHint}>
            {formatAccountingCents(expectedChangeCents)} of cash spending recorded since — expect about{' '}
            {formatAccountingCents(account.balanceCents + expectedChangeCents)}
          </Text>
        )}
      </View>
      <View style={styles.rowRight}>
        <TextInput
          value={draft}
          onChangeText={setDraft}
          keyboardType="decimal-pad"
          style={[styles.balanceInput, dirty && styles.balanceInputDirty]}
        />
        {dirty ? (
          // Save replaces Remove while there are unsaved changes: one decision
          // at a time, and no deleting an account you were mid-count on.
          <>
            <Pressable onPress={() => { void save(); }} disabled={saving} style={[styles.smallButtonDark, saving && styles.buttonDisabled]}>
              <Text style={styles.smallButtonDarkText}>{saving ? 'Saving…' : 'Save'}</Text>
            </Pressable>
            <Pressable onPress={() => setDraft(saved)}><Text style={styles.mutedText}>Cancel</Text></Pressable>
          </>
        ) : confirmingDelete ? (
          <>
            <Pressable onPress={() => { void onDelete(); }}><Text style={styles.dangerText}>Confirm</Text></Pressable>
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
  error,
  onCancel,
  onCreate,
}: {
  error: string | null;
  onCancel: () => void;
  onCreate: (
    name: string,
    balanceCents: number,
    type: CashAccount['accountType'],
    notes: string | null
  ) => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [balance, setBalance] = useState('0.00');
  const [type, setType] = useState<CashAccount['accountType']>('cash');
  // Optional: which bank branch, whose float, which drawer of the two. The
  // name alone stops being enough as soon as a shop has more than one of a
  // kind. Blank stays null rather than an empty string.
  const [notes, setNotes] = useState('');
  // The row stays mounted while the insert is in flight, so without this a
  // second tap files the account twice.
  const [saving, setSaving] = useState(false);
  const canSave = name.trim().length > 0 && !saving;

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
      <TextInput
        value={notes}
        onChangeText={setNotes}
        placeholder="Notes (optional) — which branch, whose float, account number"
        placeholderTextColor="#9B9B9B"
        style={styles.nameInput}
      />
      <View style={styles.newAccountActions}>
        <TextInput value={balance} onChangeText={setBalance} keyboardType="decimal-pad" style={styles.balanceInput} />
        <Pressable
          onPress={async () => {
            if (!canSave) return;
            setSaving(true);
            try {
              await onCreate(name.trim(), toCents(balance), type, notes.trim() || null);
            } finally {
              setSaving(false);
            }
          }}
          disabled={!canSave}
          style={[styles.smallButtonDark, !canSave && styles.buttonDisabled]}
        >
          <Text style={styles.smallButtonDarkText}>{saving ? 'Adding…' : 'Add'}</Text>
        </Pressable>
        <Pressable onPress={onCancel}><Text style={styles.mutedText}>Cancel</Text></Pressable>
      </View>
      {error && <Text style={styles.inlineError}>{error}</Text>}
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
  rowHint: { fontSize: 11, color: '#B5793A', marginTop: 3, lineHeight: 15 },
  rowRight: { flexDirection: 'row', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
  rowAmount: { fontSize: 13, fontWeight: '800', color: '#111111' },

  balanceInput: { backgroundColor: '#F2F2F2', borderRadius: 8, height: 36, width: 100, paddingHorizontal: 10, color: '#111111', textAlign: 'right', fontWeight: '700' },
  // An edited-but-unsaved figure has to look unsaved, or an explicit Save is
  // just a button nobody notices they still have to press.
  balanceInputDirty: { backgroundColor: '#FFF6E9', borderWidth: 1, borderColor: '#E0B27A' },
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
  inlineError: { color: '#C0392B', fontSize: 12, fontWeight: '700', marginTop: 8 },
});
