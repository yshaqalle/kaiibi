import { billDueState } from '@/lib/cash-budget-reporting';
import { balanceCents, invoiceStatus } from '@/lib/invoice-reporting';
import type { BudgetRow } from '@/lib/cash-budget-reporting';
import { varianceTone } from '@/lib/register-sessions';
import type { Customer, Invoice, Product, RecurringBill, RegisterSession, StaffMember, TimeEntry, TimeOffRequest } from '@/types/models';

// What needs attention right now, as pure functions over already-fetched rows.
//
// Split out of dashboard.tsx for the reason the rest of lib/ is split out (see
// sales-reporting.ts): the ORDERING here is a product decision that is easy to
// get subtly wrong and impossible to check by looking at a screen with one
// shop's data on it. It also decides what a shop owner sees first thing in the
// morning, which is worth a test.
//
// Ordering is by ACTIONABILITY, not by area. A list that opens with "3
// customers went quiet" buries the time-off request someone is waiting on and
// the supplier bill that is already late.

export type AttentionSeverity =
  /** Someone is blocked, or money is already late. Today's work. */
  | 'act'
  /** Has a deadline in view but has not arrived. This week's work. */
  | 'soon'
  /** Worth knowing. No deadline, no block. */
  | 'info';

/** Which part of the business — powers the filter chips once the list is long. */
export type AttentionArea = 'money' | 'team' | 'stock' | 'customers' | 'orders';

export type AttentionItem = {
  key: string;
  severity: AttentionSeverity;
  area: AttentionArea;
  title: string;
  detail?: string;
  /** Short imperative on the pill: "Pay", "Decide", "Reorder". */
  action?: string;
};

export type AttentionInput = {
  // Money
  openInvoices: Invoice[];
  recurringBills: RecurringBill[];
  budgetRows: BudgetRow[];
  // Sessions closed in the period, with the register and person already
  // resolved to names by the caller. Only out-of-balance ones produce a row --
  // see the note in buildAttentionItems.
  closedSessions: { session: RegisterSession; registerName: string; personName: string }[];
  // Team
  pendingTimeOff: TimeOffRequest[];
  staleShifts: TimeEntry[];
  onLeave: StaffMember[];
  // Stock
  lowStock: Product[];
  expiringSoon: Product[];
  // Customers
  dormant: { customer: Customer; lastOrderAt: string }[];
  // Storefront (Task 7). N3: this used to be every order the shop has ever
  // placed (storefrontOrders: { status: OrderStatus }[]), filtered right
  // here -- the same rule ORDERS_NEEDING_ACTION (order-status.ts) names, and
  // the same one orders.tsx and settings-sidebar.tsx each re-inlined their
  // own copy of. Callers now do that filtering AT THE QUERY
  // (countOrdersNeedingAction, storefront-admin.ts, `.in('status', ...)`
  // server-side) rather than fetching every column of every order just to
  // find one integer, so what arrives here is already the count, not
  // something left for this function to re-derive.
  ordersNeedingActionCount: number;
  today?: Date;
};

const SEVERITY_ORDER: Record<AttentionSeverity, number> = { act: 0, soon: 1, info: 2 };

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

function nameOf(customer: Customer): string {
  return [customer.firstName, customer.lastName].filter(Boolean).join(' ') || 'Customer';
}

function formatMoney(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/**
 * Everything that wants a decision, ordered so the most actionable is first.
 *
 * Every input is optional in practice: a role without `expenses.view` simply
 * passes empty arrays, and its rows drop out rather than the list erroring.
 * That mirrors how dashboard.tsx already guards each query separately.
 */
export function buildAttentionItems(input: AttentionInput): AttentionItem[] {
  const today = input.today ?? new Date();
  const items: AttentionItem[] = [];

  // ── money ────────────────────────────────────────────────────────────────
  const overdue = input.openInvoices.filter(
    (invoice) => invoiceStatus(invoice, today) === 'overdue' && balanceCents(invoice) > 0
  );
  if (overdue.length > 0) {
    const owed = overdue.reduce((sum, invoice) => sum + balanceCents(invoice), 0);
    const first = overdue[0];
    items.push({
      key: 'invoices-overdue',
      severity: 'act',
      area: 'money',
      action: 'Pay',
      title:
        overdue.length === 1
          ? `${first.vendorName ?? 'A supplier'} bill is overdue`
          : `${overdue.length} supplier bills are overdue`,
      detail: `${formatMoney(owed)} outstanding${first.invoiceNumber ? ` · #${first.invoiceNumber}` : ''}`,
    });
  }

  const dueSoon = input.recurringBills.filter(
    (bill) => bill.active && billDueState(bill, today) === 'due-soon'
  );
  for (const bill of dueSoon) {
    items.push({
      key: `bill-${bill.id}`,
      severity: 'soon',
      area: 'money',
      action: formatMoney(bill.amountCents),
      title: `${bill.name} due soon`,
      detail: `Due ${bill.nextDueDate}`,
    });
  }

  // A drawer that did not balance. NOTHING here fires on a day when every
  // register closed clean, which is the whole reason this is an attention row
  // and not a dashboard card: a card reading "$0.00 variance" every day is one
  // nobody reads by week two.
  //
  // Short is `act` and over is `soon`: short means the shop is out of pocket
  // today, over usually means a sale was rung wrong. Both get a row, because a
  // drawer that misses in either direction is one nobody can vouch for -- only
  // one of them costs money this morning.
  //
  // Deliberately absent: anything about a register being left OPEN. A session
  // may stay open as long as the shop wants; that is settled, and an alert here
  // would quietly reverse it in the first place an owner looks.
  for (const entry of input.closedSessions) {
    const variance = entry.session.varianceBaseCents ?? 0;
    if (variance === 0) continue;
    const tone = varianceTone(variance);
    items.push({
      key: `register-session-${entry.session.id}`,
      severity: tone === 'short' ? 'act' : 'soon',
      area: 'money',
      action: 'Review',
      title: `${entry.registerName} closed ${formatMoney(Math.abs(variance))} ${tone}`,
      detail: [entry.personName, entry.session.closingNote].filter(Boolean).join(' · ') || undefined,
    });
  }

  // Only budgets that are close or past. A category at 40% is not news, and
  // listing every tracked category would drown everything else.
  const tightBudgets = input.budgetRows.filter((row) => row.pctUsed !== null && row.pctUsed >= 80);
  for (const row of tightBudgets) {
    const over = row.overBy > 0;
    items.push({
      key: `budget-${row.category}`,
      severity: over ? 'act' : 'soon',
      area: 'money',
      title: over
        ? `${row.category.replace(/_/g, ' ')} budget is over by ${formatMoney(row.overBy)}`
        : `${row.category.replace(/_/g, ' ')} budget ${row.pctUsed}% used`,
      detail: `${formatMoney(row.spentCents)} of ${formatMoney(row.limitCents ?? 0)}`,
    });
  }

  // ── storefront orders ───────────────────────────────────────────────────
  // Task 7: publishing a storefront is retroactively consent to take orders,
  // and a shop that never thinks to open Settings -> Orders would otherwise
  // never find out one arrived. One row for the group, not one per order --
  // the same call the dormant-customers row below makes, and for the same
  // reason: a shop with five new orders needs to know that, not read past
  // five rows on the way to the register-drawer variance.
  if (input.ordersNeedingActionCount > 0) {
    items.push({
      key: 'storefront-orders',
      severity: 'act',
      area: 'orders',
      action: 'Review',
      title:
        input.ordersNeedingActionCount === 1
          ? '1 storefront order needs action'
          : `${input.ordersNeedingActionCount} storefront orders need action`,
      detail: 'New orders wait to be accepted, prepped ones wait to be handed over.',
    });
  }

  // ── team ─────────────────────────────────────────────────────────────────
  if (input.pendingTimeOff.length > 0) {
    items.push({
      key: 'time-off',
      severity: 'act',
      area: 'team',
      action: 'Decide',
      title: `${input.pendingTimeOff.length} time-off ${plural(input.pendingTimeOff.length, 'request', 'requests')} waiting`,
      detail: 'Approve or decline in People → Team.',
    });
  }

  if (input.staleShifts.length > 0) {
    items.push({
      key: 'stale-shifts',
      severity: 'act',
      area: 'team',
      action: 'Fix before payroll',
      title: `${input.staleShifts.length} ${plural(input.staleShifts.length, 'shift', 'shifts')} still clocked in from an earlier day`,
      // Said plainly because the knock-on is invisible otherwise: open shifts
      // are excluded from hours worked, so pay is quietly understated.
      detail: 'Those hours are not counted until they clock out — fix before running payroll.',
    });
  }

  // ── stock ────────────────────────────────────────────────────────────────
  if (input.lowStock.length > 0) {
    items.push({
      key: 'low-stock',
      severity: 'soon',
      area: 'stock',
      action: 'Reorder',
      title: `${input.lowStock.length} ${plural(input.lowStock.length, 'product', 'products')} low on stock`,
      detail: input.lowStock.slice(0, 3).map((product) => product.name).join(', '),
    });
  }

  if (input.expiringSoon.length > 0) {
    items.push({
      key: 'expiring',
      severity: 'soon',
      area: 'stock',
      action: 'Discount',
      title: `${input.expiringSoon.length} ${plural(input.expiringSoon.length, 'product', 'products')} expiring soon`,
      detail: input.expiringSoon.slice(0, 3).map((product) => product.name).join(', '),
    });
  }

  // ── worth knowing ────────────────────────────────────────────────────────
  if (input.onLeave.length > 0) {
    items.push({
      key: 'on-leave',
      severity: 'info',
      area: 'team',
      title: `${input.onLeave.length} on leave today`,
      detail: input.onLeave.map((member) => member.fullName ?? 'Staff member').join(', '),
    });
  }

  if (input.dormant.length > 0) {
    // One row for the group rather than one per customer: three separate
    // "Ayaan H. — last order 3 Jun" rows outnumbered everything actionable
    // above them, which is precisely the burying this ordering exists to stop.
    items.push({
      key: 'dormant',
      severity: 'info',
      area: 'customers',
      title: `${input.dormant.length} regular ${plural(input.dormant.length, 'customer has', 'customers have')} gone quiet`,
      detail: input.dormant
        .slice(0, 3)
        .map((entry) => `${nameOf(entry.customer)} (${new Date(entry.lastOrderAt).toLocaleDateString()})`)
        .join(', '),
    });
  }

  // Stable sort: severity decides, and within a severity the order above is
  // kept, so money-before-team-before-stock stays predictable rather than
  // shuffling between loads.
  return items.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}

/** Counts per area, for the filter chips. */
export function attentionCounts(items: AttentionItem[]): Record<AttentionArea | 'all', number> {
  const counts = { all: items.length, money: 0, team: 0, stock: 0, customers: 0, orders: 0 };
  for (const item of items) counts[item.area] += 1;
  return counts;
}
