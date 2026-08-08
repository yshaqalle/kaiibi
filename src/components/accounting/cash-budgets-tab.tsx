import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { RecurringBillModal } from '@/components/accounting/recurring-bill-modal';
import { RegisterSessionDetail } from '@/components/register-session-detail';
import { RegisterSessionsCard, type SessionRow } from '@/components/accounting/register-sessions-card';
import { useHeaderActions, type HeaderActionsSetter, useTabRefresh, type RefreshSetter } from '@/components/accounting/use-header-actions';
import { Badge } from '@/components/badge';
import { BudgetBar } from '@/components/budget-bar';
import type { DateRange } from '@/components/range-selector';
import { StatTile } from '@/components/stat-tile';
import { BentoCell, BentoGrid } from '@/components/ui/bento';
import { BentoCard } from '@/components/ui/bento-card';
import { Colors } from '@/constants/theme';
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
import { listCurrencies } from '@/lib/currencies';
import { listRegisters, listRegisterSessions, registerSessionTotals } from '@/lib/registers';
import { listStaff } from '@/lib/staff';
import { listShopTimeEntries } from '@/lib/time-entries';
import type { Budget, CashAccount, Currency, Expense, NewRecurringBillInput, RecurringBill } from '@/types/models';
import { useRefreshOnFocus } from '@/hooks/use-refresh-on-focus';

// Pinned to the light palette for now — no dark-mode switching yet.
const theme = Colors.light;

function extractErrorMessage(err: unknown): string {
  if (err && typeof err === 'object' && 'message' in err && typeof (err as { message: unknown }).message === 'string') {
    return (err as { message: string }).message;
  }
  return 'Something went wrong.';
}

export function CashBudgetsTab({
  dateRange,
  locationFilter,
  focusSessionId,
  setHeaderActions,
  setRefresh,
}: {
  dateRange: DateRange;
  /** Owned by the Accounting shell so it survives a tab switch. null = every store. */
  locationFilter: string | null;
  // A session to open on arrival, from a Dashboard attention row.
  focusSessionId?: string | null;
  setHeaderActions: HeaderActionsSetter;
  setRefresh: RefreshSetter;
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
  // Tracks the FIRST fetch, not every fetch. `reload()` runs again after each
  // edit here, and swapping the rendered rows for a placeholder on those
  // collapsed the scroll content to a few pixels -- the platform then clamps
  // the scroll offset to fit, so the list came back at the top and whoever was
  // reading it lost their place after every change. Gating on "has anything
  // arrived yet" keeps the rows mounted, so they keep their height and their
  // position, and the values update underneath. First found in inventory.tsx.
  // Sessions in the selected range, with register and person already resolved
  // to names — the card renders, it does not look things up.
  const [sessionRows, setSessionRows] = useState<SessionRow[]>([]);
  const [currencies, setCurrencies] = useState<Currency[]>([]);
  const [openSession, setOpenSession] = useState<SessionRow | null>(null);
  // Which deep-linked session has already been dismissed, so closing the sheet
  // does not immediately reopen it. Derived rather than synced in an effect —
  // the param does not change while the screen is up.
  const [dismissedFocus, setDismissedFocus] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { since, until } = dateRange;
  // Wages owed are money about to leave; showing cash without them reads
  // more comfortable than it is.
  const canSeeWagesOwed = can('people.payroll.manage') && can('expenses.manage');

  const reload = useCallback(async () => {
    if (!shop || !allowed) {
      setLoaded(true);
      return;
    }
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

      // Registers, in their own try: a shop that never opened one, or a role
      // that cannot read sessions, gets an empty card rather than losing the
      // whole tab. Same fail-soft posture the rest of this screen takes.
      try {
        const [registerRows, sessions, currencyRows, members] = await Promise.all([
          listRegisters(shop.id),
          listRegisterSessions(shop.id, { locationId: locationFilter, limit: 60 }),
          listCurrencies(shop.id),
          listStaff(shop.id).catch(() => []),
        ]);
        const registerName = new Map(registerRows.map((r) => [r.id, r.name]));
        const registerNote = new Map(registerRows.map((r) => [r.id, r.note]));
        const memberName = new Map(members.map((m) => [m.id, m.fullName ?? m.email ?? 'Staff']));
        // Opened inside the range, or still open — a session that started last
        // month and is still running is very much this month's problem.
        const inRange = sessions.filter(
          (session) => !session.closedAt || new Date(session.openedAt) >= since
        );
        const totals = await registerSessionTotals(inRange.map((session) => session.id));
        setCurrencies(currencyRows);
        setSessionRows(
          inRange.map((session) => ({
            session,
            registerName: registerName.get(session.registerId) ?? 'A register',
            registerNote: registerNote.get(session.registerId) ?? null,
            // An owner-run session carries no roster row (see 20260822000200),
            // so it is named generically rather than rendering "undefined".
            personName: session.shopMemberId ? memberName.get(session.shopMemberId) ?? 'Staff' : 'The owner',
            saleCount: totals.get(session.id)?.saleCount ?? 0,
            takenCents: totals.get(session.id)?.totalCents ?? 0,
          }))
        );
      } catch {
        setSessionRows([]);
        setCurrencies([]);
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
      setLoaded(true);
    }
  }, [shop, allowed, since, until, canSeeWagesOwed, locationFilter]);

  useEffect(() => { reload(); }, [reload]);
  // Coming back to this screen on a phone, where the tab shell never unmounted
  // it, so its data is as old as the last time it was looked at.
  useRefreshOnFocus(reload);
  // Published to the shell, which owns the scroller the pull happens on.
  useTabRefresh(setRefresh, reload);

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
      <BentoGrid>
        <BentoCell span={12}>
          <BentoCard title="Cash & Budgets">
            <Text style={styles.empty}>
              Cash and budgets need the budgets permission. Ask an owner to grant it in Settings → Roles.
            </Text>
          </BentoCard>
        </BentoCell>
      </BentoGrid>
    );
  }

  const cashTotal = totalCashCents(accountsInScope);
  const monthlyCommitment = monthlyBillCommitmentCents(billsInScope);
  const rows = budgetRows(expensesInScope, budgetsInScope);

  // Which session the detail sheet shows. An explicit tap wins; otherwise the
  // one a Dashboard attention row deep-linked to, until it is dismissed.
  // Derived rather than synced in an effect — the param cannot change while the
  // screen is up, so there is nothing to keep in step.
  const focusedRow =
    focusSessionId && focusSessionId !== dismissedFocus
      ? sessionRows.find((row) => row.session.id === focusSessionId) ?? null
      : null;
  const detailRow = openSession ?? focusedRow;

  return (
    <View>
      <CashBudgetsHeaderActions
        onNewBill={() => setEditingBill('new')}
        setHeaderActions={setHeaderActions}
      />

      {error && <Text style={styles.error}>{error}</Text>}

      <BentoGrid>
        <BentoCell span={12}>
          <BentoCard title="Cash position" scope="As of today">
            <View style={styles.metricRow}>
              <StatTile variant="bento" value={formatCompactCents(cashTotal)} label="Cash on hand" />
              <StatTile variant="bento" value={formatCompactCents(monthlyCommitment)} label="Committed each month" />
              {canSeeWagesOwed && accruedWagesCents > 0 && (
                <StatTile variant="bento" value={formatCompactCents(accruedWagesCents)} label="Wages owed" tone="warning" />
              )}
            </View>
            {/* Worth saying out loud: this is the number that catches shops
                out. Stock purchases drain the bank without being an expense,
                so profit and cash routinely disagree. */}
            <Text style={styles.caption}>
              Cash on hand is what you last counted, not a calculated figure — update it when you check. Profit and cash aren&apos;t
              the same thing: buying stock takes money out now but only becomes a cost when it sells.
              {canSeeWagesOwed && accruedWagesCents > 0
                ? ' Wages owed covers hours already worked that no pay run has settled — that money is still to go out.'
                : ''}
            </Text>
          </BentoCard>
        </BentoCell>

      {!loaded ? (
        <BentoCell span={12}>
          {/* In a card, like every other state on this screen. Bare grey text
              on the page reads as the screen having failed rather than as it
              still working. */}
          <BentoCard>
            <Text style={styles.empty}>Loading…</Text>
          </BentoCard>
        </BentoCell>
      ) : (
        <>
          {/* --- Cash on hand: a snapshot, not driven by the date range --- */}
          <BentoCell span={5}>
          <BentoCard
            title="Cash on hand"
            scope="As of today"
            actions={
              <Pressable onPress={() => setAddingAccount(true)} style={styles.smallButton}>
                <Text style={styles.smallButtonText}>+ Account</Text>
              </Pressable>
            }
          >
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
          </BentoCard>
          </BentoCell>

          {/* --- Recurring bills: forward-looking, also range-independent --- */}
          <BentoCell span={7}>
          <BentoCard title="Recurring bills" scope="As of today">
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
                        <Badge variant="bento"
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
          </BentoCard>
          </BentoCell>

          {/* --- Who was on which register, and whether the drawer added up.
              Beside cash on hand because it is the same question asked over
              time: this tab already owns where the money physically is. --- */}
          <BentoCell span={12}>
            <RegisterSessionsCard
              rows={sessionRows}
              currencies={currencies}
              onOpenSession={setOpenSession}
            />
            {/* Mounted only while open and keyed by session, so it loads the
                run fresh instead of needing an effect to reset it. */}
            {detailRow && (
              <RegisterSessionDetail
                key={detailRow.session.id}
                sessionId={detailRow.session.id}
                registerName={detailRow.registerName}
                registerNote={detailRow.registerNote}
                nameFor={(session) =>
                  sessionRows.find((row) => row.session.id === session.id)?.personName ??
                  (session.shopMemberId ? 'Staff' : 'The owner')
                }
                currencies={currencies}
                onClose={() => {
                  setOpenSession(null);
                  if (focusSessionId) setDismissedFocus(focusSessionId);
                }}
              />
            )}
          </BentoCell>

          {/* --- Budget vs actual: the one section the date range drives, so
              it is the only card here that doesn't say "as of today". --- */}
          <BentoCell span={12}>
          <BentoCard title="Budget vs. actual" scope="Selected range">
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
          </BentoCard>
          </BentoCell>
        </>
      )}
      </BentoGrid>

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
  metricRow: { flexDirection: 'row', gap: 10, flexWrap: 'wrap' },
  caption: { fontSize: 11.5, color: theme.bentoMuted, lineHeight: 17, marginTop: 12 },

  // `sectionHeader`/`sectionTitle`/`card` are gone: each section is now a
  // BentoCard, which owns its own heading, padding and white surface. They
  // used to be a bare bordered block with the title floating outside it,
  // which read as an unstyled list rather than a card.
  sectionEmpty: { fontSize: 12.5, color: theme.bentoMuted, paddingVertical: 6 },
  sectionNote: { fontSize: 11, color: theme.bentoMuted, lineHeight: 16, marginTop: 10 },

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
