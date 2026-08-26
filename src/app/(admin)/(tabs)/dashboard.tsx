import { useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AttentionList } from '@/components/attention-list';
import { BarChart, GroupedBarChart, type BarPoint, type GroupedBarPoint } from '@/components/bar-chart';
import { Card } from '@/components/card';
import { BestSellersCard } from '@/components/dashboard/best-sellers-card';
import { GreetingBand, summarySentence } from '@/components/dashboard/greeting-band';
import { LeaderboardCard, type LeaderboardEntry } from '@/components/dashboard/leaderboard-card';
import { OpenHoursCard } from '@/components/dashboard/open-hours-card';
import {
  CostedProductsCard,
  InventoryGlanceCard,
  IncomePaidCard,
  MarginGaugeCard,
  RevenueGoalCard,
  RevenueSparkCard,
} from '@/components/dashboard/overview-cards';
import { TakingsHeroCard, type TakingsMethod } from '@/components/dashboard/takings-hero-card';
import { SalesPaceCard } from '@/components/dashboard/sales-pace-card';
import { TopMoverCard } from '@/components/dashboard/top-mover-card';
import { DashboardPageHeader } from '@/components/dashboard/page-header';
import { PaymentMixChart, type PaymentMixItem } from '@/components/payment-mix-chart';
import { type DateRange, type RangePreset } from '@/components/range-selector';
import { StatTile } from '@/components/stat-tile';
import { TrendChart, type TrendPoint } from '@/components/trend-chart';
import { WaterfallChart } from '@/components/waterfall-chart';
import { BentoCell, BentoGrid, BentoZone, MIN_TILE } from '@/components/ui/bento';
import { BentoControlBar } from '@/components/ui/bento-control-bar';
import { Caveat } from '@/components/ui/caveat';
import { DataTable, NameCell, ValueCell } from '@/components/ui/data-table';
import { DeltaBadge } from '@/components/ui/delta-badge';
import { StatementRow } from '@/components/ui/statement-row';
import { Colors } from '@/constants/theme';
import { useAuth } from '@/hooks/use-auth';
import { useCaveatDismissal } from '@/hooks/use-caveat-dismissal';
import { buildAttentionItems, type AttentionItem } from '@/lib/attention';
import { budgetRows, monthlyBillCommitmentCents, type BudgetRow } from '@/lib/cash-budget-reporting';
import { listBudgets, listRecurringBills } from '@/lib/cash-budgets';
import { formatAccountingCents, formatCompactCents } from '@/lib/currency';
import { customerDisplayName, dormantCustomers, getCustomersStatsBatch, listCustomers } from '@/lib/customers';
import { operatingExpenseCents } from '@/lib/expense-reporting';
import { dayKeyFor } from '@/lib/period';
import { listExpensesInRange } from '@/lib/expenses';
import { invoiceTotals } from '@/lib/invoice-reporting';
import { listOpenInvoices } from '@/lib/invoices';
import { scopeToLocation } from '@/lib/location-reporting';
import { listPayrollRuns } from '@/lib/payroll';
import { methodLabel } from '@/lib/payment-methods';
import { accruedLaborCents } from '@/lib/payroll-reporting';
import { profitAndLoss } from '@/lib/pnl';
import { getExpiringProducts, getLowStockProducts } from '@/lib/products';
import { formatRangeLabel } from '@/lib/range-label';
import { WEEK_ORDER, type OpeningHours } from '@/lib/store-hours';
import { countOrdersNeedingAction } from '@/lib/storefront-admin';
import type { SearchResult } from '@/lib/search';
import { getDailyTotalsCents, getMonthToDateRevenueCents, getSalesAndRefundsInRange, listSales } from '@/lib/sales';
import {
  cashierPerformance,
  costOfGoodsSold,
  paymentMethodMix,
  productDailyRevenue,
  productMovers,
  netRevenueCents,
  productPerformance,
  type CogsResult,
  type DailyBucket,
  type ProductSales,
} from '@/lib/sales-reporting';
import { membersActiveToday, onLeaveMemberIds, staleOpenShifts } from '@/lib/shift-hours';
import { listRegisters, listRegisterSessions } from '@/lib/registers';
import { listStaff } from '@/lib/staff';
import { listShopTimeEntries } from '@/lib/time-entries';
import { listShopTimeOffRequests } from '@/lib/time-off';
import type { Customer, Expense, Invoice, Product, RecurringBill, RegisterSession, Sale, StaffMember, TimeEntry, TimeOffRequest } from '@/types/models';
import { useRefreshOnFocus } from '@/hooks/use-refresh-on-focus';
import { usePullToRefresh } from '@/hooks/use-pull-to-refresh';

// The Dashboard answers one question: what needs attention right now. The
// deeper analysis it used to carry -- rankings, category mix, payment split --
// moved to Accounting, which is built for it. What's left is a pulse check and
// a list of things to act on.

// Pinned to the light palette for now — no dark-mode switching yet.
const theme = Colors.light;

// Supabase/PostgREST errors are plain {code, message} objects, never
// `instanceof Error`, so an instanceof check alone always falls through.
function extractErrorMessage(err: unknown): string {
  if (err && typeof err === 'object' && 'message' in err && typeof (err as { message: unknown }).message === 'string') {
    return (err as { message: string }).message;
  }
  return 'Could not load some dashboard data.';
}

const DASHBOARD_PRESETS: RangePreset[] = [
  { label: 'Today', days: 1 },
  { label: '7 days', days: 7 },
  { label: '30 days', days: 30 },
];

// "Tomorrow" and "In 3 days" rather than a date: the column exists to convey
// urgency, and a reader should not have to subtract dates to feel it.
function formatExpiry(expiryDate: string | null): string {
  if (!expiryDate) return '—';
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const due = new Date(expiryDate);
  due.setHours(0, 0, 0, 0);
  const days = Math.round((due.getTime() - start.getTime()) / 86_400_000);
  if (days < 0) return `${Math.abs(days)}d ago`;
  if (days === 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  return `In ${days} days`;
}

function startOfThisMonth(): Date {
  const start = new Date();
  start.setDate(1);
  start.setHours(0, 0, 0, 0);
  return start;
}

function daysLeftInMonth(): number {
  const today = new Date();
  const lastDay = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
  return Math.max(0, lastDay - today.getDate());
}

/**
 * The same-length window immediately before this one — what "up 12%" is
 * measured against.
 *
 * Ends one millisecond before the current window opens rather than on the day
 * before it, so no sale can land in both and be counted twice.
 */
function previousWindow(since: Date, until?: Date): { since: Date; until: Date } {
  const end = until ?? new Date();
  const span = Math.max(86_400_000, end.getTime() - since.getTime());
  return { since: new Date(since.getTime() - span), until: new Date(since.getTime() - 1) };
}

// How deep to look when ranking products. Not a display limit: `productMovers`
// measures each product's share against the period's whole product revenue, so
// a truncated list would inflate every share and let the 2% floor through
// products that do not deserve it.
const PRODUCT_SCAN_LIMIT = 500;
const BEST_SELLER_LIMIT = 6;
const LEADERBOARD_LIMIT = 6;
// Position in the movers row. Named rather than numbered: "Biggest move" says
// what the ordering IS, where "1" only says there is one.
const MOVER_RANKS = ['Biggest move', 'Second', 'Third'];

// A key for a two-series chart. The swatch and the word travel together --
// the series colours are chosen to separate for colour-blind readers, but a
// legend that is only a colour still needs the word beside it.
function Legend({ color, label }: { color: string; label: string }) {
  return (
    <View style={styles.legendItem}>
      <View style={[styles.legendDot, { backgroundColor: color }]} />
      <Text style={styles.legendLabel}>{label}</Text>
    </View>
  );
}

type HrSnapshot = {
  activeToday: number;
  // The denominator. "3 on today" is not a fact until you know whether the
  // shop has four staff or forty.
  teamTotal: number;
  onLeave: StaffMember[];
  staleShifts: TimeEntry[];
  pendingTimeOff: TimeOffRequest[];
};

// What the shop owes and what it has committed to. Read separately from the
// range above, because what you owe is a fact about RIGHT NOW -- a bill raised
// four months ago and never paid is exactly the one worth surfacing (same
// reasoning as invoiceTotals in lib/invoice-reporting.ts).
type MoneySnapshot = {
  openInvoices: Invoice[];
  recurringBills: RecurringBill[];
  budgets: BudgetRow[];
};

export default function DashboardScreen() {
  const router = useRouter();
  const { shop, can, hasModule, locations, activeLocation } = useAuth();
  // Time and leave data is RLS-protected; without these the queries would just
  // fail, so the rows are left out rather than erroring the whole screen.
  const canSeeTeam = can('people.timesheet.view');
  const canApproveTimeOff = can('people.timeoff.approve');
  const canSeeExpenses = can('expenses.view');
  const canSeeCustomers = can('customers.view');
  // Task 7: a shop without the module was never offered a way to take
  // orders in the first place, so there is nothing here for it to miss --
  // same gate the Storefront/Orders nav entries use (settings-sidebar.tsx).
  const canSeeOrders = hasModule('storefront');
  // Gates the accrued-wages line on the P&L card. Same permission Reports
  // uses, so the two screens include or exclude labour together -- a reader
  // who sees the accrual there must see it here, or the same shop shows two
  // net profits.
  const canSeeLabor = can('people.payroll.manage');

  // Which store the FIGURES are for. Deliberately separate from
  // `activeLocation`, which is where this DEVICE is operating -- a till at
  // Airport Road stays Airport Road's till while its owner looks at the
  // Berbera numbers. null is the combined business view, matching Accounting.
  //
  // Defaults to the device's branch rather than to null: someone standing at a
  // counter is asking about that counter. A single-store shop sees no control
  // at all (LocationFilterRow renders nothing), so this costs them nothing.
  const [locationFilter, setLocationFilter] = useState<string | null>(activeLocation?.id ?? null);
  const [dateRange, setDateRange] = useState<DateRange | null>(null);
  const [daily, setDaily] = useState<DailyBucket[]>([]);
  // The rows, not just their total: the P&L card splits operating from
  // stock-and-draws, which a single summed figure cannot do.
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [paymentMix, setPaymentMix] = useState<PaymentMixItem[]>([]);
  // Named for the figure, not the function that computes it: `accruedLaborCents`
  // is imported from payroll-reporting and a state variable of that name
  // shadows it.
  const [accruedWagesCents, setAccruedWagesCents] = useState(0);
  const [lowStock, setLowStock] = useState<Product[]>([]);
  const [expiringSoon, setExpiringSoon] = useState<Product[]>([]);
  const [monthToDateCents, setMonthToDateCents] = useState(0);
  // The same month, day by day — what the Open hours card's Weeks view plots.
  // Separate from `monthToDateCents` because a single total cannot be split
  // into weeks after the fact.
  const [monthDaily, setMonthDaily] = useState<DailyBucket[]>([]);
  const [dormant, setDormant] = useState<{ customer: Customer; lastOrderAt: string }[]>([]);
  // Task 7 / N3. Used to be every order the shop ever placed, all columns
  // plus nested order_items, fetched on every focus to feed one filter in
  // buildAttentionItems -- countOrdersNeedingAction (storefront-admin.ts)
  // does that filtering server-side and returns the integer this screen
  // actually needs.
  const [ordersNeedingActionCount, setOrdersNeedingActionCount] = useState(0);
  // Only sessions that closed out of balance ever land here — see the note in
  // buildAttentionItems for why a balanced day shows nothing at all.
  const [closedSessions, setClosedSessions] = useState<
    { session: RegisterSession; registerName: string; personName: string }[]
  >([]);
  const [recentSales, setRecentSales] = useState<Sale[]>([]);
  // Every sale in the range, with its items. Already fetched for COGS and the
  // payment mix; keeping it means best sellers, top movers, open hours and
  // top performers all cost nothing more than the arithmetic.
  const [rangeSales, setRangeSales] = useState<Sale[]>([]);
  // What sold in the SAME-LENGTH window immediately before this one. Its own
  // piece of state rather than a flag on the range, because `null` and "an
  // empty window" are different: null means nobody asked, and Top movers must
  // not report every product as brand new because a query failed.
  const [priorProducts, setPriorProducts] = useState<ProductSales[] | null>(null);
  // Same window, for the delta badges. Null until fetched, for the same
  // reason: no badge at all beats a comparison against an assumed zero.
  //
  // `netProfitCents` here excludes accrued wages — the prior window's labour
  // is not fetched — so the KPI strip only badges net profit when the current
  // window has no accrual either. See the badge below.
  const [prior, setPrior] = useState<{
    revenueCents: number;
    expenseCents: number;
    orderCount: number;
    netProfitCents: number;
  } | null>(null);
  const [topCustomers, setTopCustomers] = useState<LeaderboardEntry[]>([]);
  const [hr, setHr] = useState<HrSnapshot | null>(null);
  const [money, setMoney] = useState<MoneySnapshot | null>(null);
  const [cogs, setCogs] = useState<CogsResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<ScrollView>(null);
  const gridOffset = useRef<number | null>(null);
  const attentionOffset = useRef<number | null>(null);
  const plOffset = useRef<number | null>(null);

  const reload = useCallback(async () => {
    if (!shop || !dateRange) return;
    const { since, until } = dateRange;
    const failures: string[] = [];

    // Guarded per section rather than as one block. The permission checks
    // above are only the client's view of what a role may read; if they ever
    // drift from the RLS policies, a refused query should cost its own
    // section, not blank the entire dashboard.
    const attempt = async (label: string, run: () => Promise<void>) => {
      try {
        await run();
      } catch (err) {
        failures.push(`${label} (${extractErrorMessage(err)})`);
      }
    };

    await attempt('sales', async () => {
      const [dailyRows, low, expiring, recent, salesAndRefunds] = await Promise.all([
        getDailyTotalsCents(shop.id, since, until, locationFilter),
        // A branch that is out of an item needs reordering even when the other
        // branch is overflowing, and a shop-wide rollup hides exactly that.
        getLowStockProducts(shop.id, shop.defaultLowStockLevel, locationFilter),
        shop.expiryTrackingEnabled ? getExpiringProducts(shop.id, shop.expiryWarningLeadDays) : Promise.resolve([]),
        listSales(shop.id, 5, locationFilter),
        // The one query this screen did not previously make. The landing page
        // sells "real profit, not guesswork" and the home screen showed no
        // profit at all -- costOfGoodsSold() has been in sales-reporting.ts
        // the whole time with no caller here.
        getSalesAndRefundsInRange(shop.id, since, until, locationFilter),
      ]);
      setDaily(dailyRows);
      setLowStock(low);
      setExpiringSoon(expiring);
      setRecentSales(recent);
      setCogs(costOfGoodsSold(salesAndRefunds.sales, salesAndRefunds.refunds));
      // Free: the same sales set that costOfGoodsSold just consumed. This is
      // why the payment card costs no extra round trip.
      setPaymentMix(paymentMethodMix(salesAndRefunds.sales));
      // Same set again. Best sellers, open hours and top performers are all
      // arithmetic over these rows -- four cards, no extra query.
      setRangeSales(salesAndRefunds.sales);
    });

    // The one genuinely extra round trip on this screen, and it buys exactly
    // one card. Its own attempt() so that a failure costs Top movers alone
    // rather than the range's own figures.
    await attempt('what moved', async () => {
      const { since: priorSince, until: priorUntil } = previousWindow(since, until);
      const [priorSales, priorExpenses] = await Promise.all([
        getSalesAndRefundsInRange(shop.id, priorSince, priorUntil, locationFilter),
        canSeeExpenses ? listExpensesInRange(shop.id, priorSince, priorUntil) : Promise.resolve([]),
      ]);
      setPriorProducts(productPerformance(priorSales.sales, PRODUCT_SCAN_LIMIT));
      const priorRevenueCents = netRevenueCents(priorSales.sales, priorSales.refunds);
      const priorExpenseCents = operatingExpenseCents(scopeToLocation(priorExpenses, locationFilter));
      // Free — the same sales set the movers already consumed. Cost of goods
      // is what makes a net-profit comparison possible at all; without it the
      // strip could only compare revenue, which moves for reasons profit does
      // not.
      const priorCogsCents = costOfGoodsSold(priorSales.sales, priorSales.refunds).cogsCents;
      setPrior({
        revenueCents: priorRevenueCents,
        expenseCents: priorExpenseCents,
        // One sale is one order, the same count `getDailyTotalsCents` buckets.
        orderCount: priorSales.sales.length,
        netProfitCents: priorRevenueCents - priorCogsCents - priorExpenseCents,
      });
    });

    if (canSeeExpenses) {
      await attempt('expenses', async () => {
        const rows = await listExpensesInRange(shop.id, since, until);
        setExpenses(scopeToLocation(rows, locationFilter));
      });

      // Wages worked but not yet settled by a pay run. Its own attempt()
      // because it needs three more queries and a separate permission -- a
      // shop without payroll access still gets its P&L, with the accrual
      // line absent rather than the card missing.
      if (canSeeLabor) {
        await attempt('wages', async () => {
          const rangeEnd = until ?? new Date();
          const [members, entries, runs] = await Promise.all([
            listStaff(shop.id),
            listShopTimeEntries(shop.id, { sinceIso: since.toISOString() }),
            listPayrollRuns(shop.id),
          ]);
          setAccruedWagesCents(accruedLaborCents(members, entries, since, rangeEnd, runs).accruedCents);
        });
      }

      // Drawers that did not balance. Its own attempt() like the rest: a shop
      // with no registers resolves to an empty list and simply contributes no
      // rows, rather than costing the whole attention list.
      await attempt('registers', async () => {
        const [registers, sessions, members] = await Promise.all([
          listRegisters(shop.id),
          listRegisterSessions(shop.id, { limit: 40 }),
          listStaff(shop.id).catch(() => []),
        ]);
        const registerName = new Map(registers.map((r) => [r.id, r.name]));
        const memberName = new Map(members.map((m) => [m.id, m.fullName ?? m.email ?? 'Staff']));
        setClosedSessions(
          sessions
            .filter((session) => session.closedAt && (session.varianceBaseCents ?? 0) !== 0)
            .map((session) => ({
              session,
              registerName: registerName.get(session.registerId) ?? 'A register',
              // An owner-run session has no roster row, so it falls back to a
              // generic word rather than rendering "undefined" at someone.
              personName: session.shopMemberId ? memberName.get(session.shopMemberId) ?? 'Staff' : 'The owner',
            }))
        );
      });

      // Same permission -- bills, budgets and what is owed to suppliers are
      // the same kind of secret -- but its own attempt(), so a shop with no
      // bills tables populated doesn't cost the expenses total above.
      await attempt('bills', async () => {
        const [invoices, bills, budgets, expenses] = await Promise.all([
          listOpenInvoices(shop.id),
          listRecurringBills(shop.id),
          listBudgets(shop.id),
          // Budgets are monthly, so they are measured against the month --
          // not against whatever range the selector happens to be showing.
          listExpensesInRange(shop.id, startOfThisMonth()),
        ]);
        // Scoped client-side: these tables are small, and scopeToLocation is
        // the same filter the accounting screens use, so a per-store view here
        // can't disagree with a per-store P&L there.
        //
        // Note the asymmetry it carries: a per-store view EXCLUDES
        // business-wide rows (a licence, group marketing), so per-store
        // figures do not sum to the business's. That is deliberate -- see
        // lib/location-reporting.ts.
        setMoney({
          openInvoices: scopeToLocation(invoices, locationFilter),
          recurringBills: scopeToLocation(bills, locationFilter),
          budgets: budgetRows(scopeToLocation(expenses, locationFilter), scopeToLocation(budgets, locationFilter)),
        });
      });
    }

    if (canSeeCustomers) {
      await attempt('customers', async () => {
        const [customers, stats] = await Promise.all([listCustomers(shop.id), getCustomersStatsBatch(shop.id)]);
        setDormant(dormantCustomers(customers, stats));
        // LIFETIME spend, from the same batch dormancy already reads. It does
        // NOT follow the date range, which is why the card beside it carries a
        // fixed "All time" scope -- see LeaderboardCard.
        setTopCustomers(
          customers
            .map((customer) => {
              const stat = stats.get(customer.id);
              return {
                name: customerDisplayName(customer),
                valueCents: stat?.totalSpentCents ?? 0,
                meta: stat ? `${stat.visitCount} ${stat.visitCount === 1 ? 'order' : 'orders'}` : undefined,
              };
            })
            .filter((entry) => entry.valueCents > 0)
            .sort((a, b) => b.valueCents - a.valueCents)
            .slice(0, LEADERBOARD_LIMIT)
        );
      });
    }

    // Task 7. Its own attempt(), like every other section here -- a shop
    // without the module skips this entirely (canSeeOrders is false), and a
    // shop with it but a failed fetch loses only this row, not the screen.
    if (canSeeOrders) {
      await attempt('orders', async () => {
        setOrdersNeedingActionCount(await countOrdersNeedingAction(shop.id));
      });
    }

    if (canSeeTeam) {
      await attempt('team', async () => {
        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);
        // Reach back a week so a shift left open on an earlier day is still
        // visible -- that's the whole point of flagging them.
        const lookback = new Date(todayStart.getTime() - 7 * 86_400_000);
        const [members, entries, timeOff] = await Promise.all([
          listStaff(shop.id),
          listShopTimeEntries(shop.id, { sinceIso: lookback.toISOString() }),
          canApproveTimeOff ? listShopTimeOffRequests(shop.id) : Promise.resolve([]),
        ]);
        const leaveIds = onLeaveMemberIds(timeOff);
        setHr({
          activeToday: membersActiveToday(entries),
          teamTotal: members.length,
          onLeave: members.filter((m) => leaveIds.has(m.id)),
          staleShifts: staleOpenShifts(entries),
          pendingTimeOff: timeOff.filter((r) => r.status === 'pending'),
        });
      });
    }

    setError(failures.length ? `Couldn't load ${failures.join(', ')}.` : null);
    // locationFilter is a dependency because every figure above is scoped to
  // it -- switching store must re-fetch, not leave the previous store's
  // numbers on screen under a new label.
  }, [shop, dateRange, locationFilter, canSeeExpenses, canSeeCustomers, canSeeTeam, canApproveTimeOff, canSeeLabor, canSeeOrders]);

  useEffect(() => { reload(); }, [reload]);
  // Coming back to this screen on a phone, where the tab shell never unmounted
  // it, so its data is as old as the last time it was looked at.
  useRefreshOnFocus(reload);
  // The manual counterpart: the only way to pick up another till's sale,
  // since nothing is pushed to this device.
  const pullToRefresh = usePullToRefresh(reload);

  // The goal is a calendar-month commitment, so it stays independent of
  // whatever range is selected above.
  useEffect(() => {
    if (!shop) return;
    // Scoped to the same store the goal belongs to, so the meter compares like
    // with like.
    getMonthToDateRevenueCents(shop.id, locationFilter).then(setMonthToDateCents);
    // Same window, bucketed. The Weeks view needs the shape, not just the sum.
    getDailyTotalsCents(shop.id, startOfThisMonth(), undefined, locationFilter)
      .then(setMonthDaily)
      // Its own catch: Weeks is one view of one card, and a failure here must
      // not take the goal meter down with it.
      .catch(() => setMonthDaily([]));
  }, [shop, locationFilter]);

  const revenueCents = useMemo(() => daily.reduce((sum, d) => sum + d.netRevenueCents, 0), [daily]);
  const orderCount = useMemo(() => daily.reduce((sum, d) => sum + d.orderCount, 0), [daily]);

  // The goal belongs to whichever store is SELECTED, not to whichever one this
  // device happens to be operating at — otherwise the meter compares one
  // branch's target against another branch's takings, which is the exact
  // mismatch this screen used to ship.
  //
  // For the combined view the goals sum, because a business-wide target is the
  // sum across stores (see ShopLocation.monthlyRevenueGoalCents). A store with
  // no goal set contributes nothing rather than blocking the total.
  const goalCents = useMemo(() => {
    const active = locations.filter((location) => location.active);
    if (locationFilter === null) {
      return active.reduce((sum, location) => sum + (location.monthlyRevenueGoalCents ?? 0), 0);
    }
    return active.find((location) => location.id === locationFilter)?.monthlyRevenueGoalCents ?? 0;
  }, [locations, locationFilter]);

  // Shared with Accounting → Reports rather than recomputed. The two screens
  // disagreed before this existed: the Expenses tile here summed EVERY expense
  // row, stock purchases and owner draws included, while Reports took only the
  // operating ones -- so the same shop, in the same range, was told two
  // different things about what it had spent. See lib/pnl.ts.
  const pnl = useMemo(
    () =>
      profitAndLoss({
        revenueCents,
        cogsCents: cogs?.cogsCents ?? 0,
        expenses,
        accruedLaborCents: accruedWagesCents,
      }),
    [revenueCents, cogs, expenses, accruedWagesCents]
  );
  const grossProfitCents = pnl.grossProfitCents;

  // Keyed to the shortfall, not to a boolean: closing this says "I've seen
  // that these two items cost me nothing on paper", not "never warn me about
  // uncosted stock again". Sell a third uncosted item and the figure is wrong
  // by a new amount, so the note earns its place back.
  const uncostedNote = useCaveatDismissal(
    'dashboard.uncosted-cogs',
    `${cogs?.uncostedItemCount ?? 0}:${cogs?.uncostedRevenueCents ?? 0}`
  );
  const noPayrollNote = useCaveatDismissal('dashboard.no-payroll-access', 'v1');

  const owed = useMemo(() => invoiceTotals(money?.openInvoices ?? []), [money]);
  const monthlyCommitmentCents = useMemo(
    () => monthlyBillCommitmentCents(money?.recurringBills ?? []),
    [money]
  );

  // The goal card used to print the store name in its own title. It no longer
  // needs to: the control bar at the top of the screen names the store every
  // figure below it is scoped to, and no other card repeats that.

  // "Show my tasks" jumps to the Needs attention card. The offset is captured
  // from the cell's own onLayout rather than measured on demand: measure() is
  // asynchronous and inconsistent across native and web, while the layout
  // event is already fired for us and is exact.
  // Same two-offset trick as scrollToAttention below: the cell knows where it
  // is inside the grid, the grid knows where it is inside the scroll view, and
  // neither alone lands in the right place.
  const scrollToProfitAndLoss = () => {
    if (plOffset.current === null || gridOffset.current === null) return;
    scrollRef.current?.scrollTo({ y: Math.max(0, gridOffset.current + plOffset.current - 16), animated: true });
  };

  const scrollToAttention = () => {
    if (attentionOffset.current === null || gridOffset.current === null) return;
    // Two offsets summed: the cell reports its position inside the grid, and
    // the grid reports its own inside the scroll content. Either alone lands
    // in the wrong place.
    const target = gridOffset.current + attentionOffset.current;
    // A little above the card, so its heading isn't flush against the top.
    scrollRef.current?.scrollTo({ y: Math.max(0, target - 16), animated: true });
  };

  // Shared with Accounting via lib/range-label.ts, so the same range is named
  // the same thing on both screens — this used to say "7 days" here while
  // Accounting spelled out "7/30/2026 – today" for the identical window.
  const rangeLabel = useMemo(
    () => (dateRange ? formatRangeLabel(dateRange, DASHBOARD_PRESETS) : ''),
    [dateRange]
  );

  const trendData: TrendPoint[] = useMemo(
    () =>
      daily.map((d) => ({
        // Not [0]: a column of M/T/W/T/F/S/S is ambiguous twice over, and
        // TrendChart only draws labels at 10 points or fewer, so the short
        // name always fits.
        label: new Date(d.day).toLocaleDateString(undefined, { weekday: 'short' }),
        value: d.netRevenueCents,
      })),
    [daily]
  );

  // The best day in the range and what it took. A line answers "which way is
  // this going"; it does not answer "which day was the good one", and that is
  // the thing an owner acts on — it is the day worth staffing.
  const revenuePeak = useMemo(() => {
    if (daily.length === 0) return null;
    const top = daily.reduce((best, d) => (d.netRevenueCents > best.netRevenueCents ? d : best));
    return {
      // Weekday names repeat once a range is longer than a week, so a longer
      // range gets a date instead. "Tuesday" in a 30-day window names four days.
      label: new Date(top.day).toLocaleDateString(
        undefined,
        daily.length <= 7 ? { weekday: 'long' } : { month: 'short', day: 'numeric' }
      ),
      cents: top.netRevenueCents,
    };
  }, [daily]);

  // What the payment card sums to. Takings, not revenue: this is money
  // collected, tax included, which is why it does not match the P&L above it.
  const takingsCents = useMemo(
    () => paymentMix.reduce((sum, entry) => sum + entry.amountCents, 0),
    [paymentMix]
  );

  // Every product sold in the range, ranked. Scanned deep rather than capped
  // at what is displayed, because the movers' share floor is measured against
  // the whole of it.
  const products = useMemo(() => productPerformance(rangeSales, PRODUCT_SCAN_LIMIT), [rangeSales]);
  const productRevenueCents = useMemo(() => products.reduce((sum, p) => sum + p.revenueCents, 0), [products]);

  const movers = useMemo(
    () => productMovers(products, priorProducts ?? [], { hasPrevious: priorProducts !== null }),
    [products, priorProducts]
  );

  const cashiers = useMemo(
    () =>
      cashierPerformance(rangeSales, LEADERBOARD_LIMIT).map<LeaderboardEntry>((row) => ({
        name: row.name,
        valueCents: row.revenueCents,
      })),
    [rangeSales]
  );

  const orderPoints: BarPoint[] = useMemo(
    () =>
      daily.map((d) => ({
        label: new Date(d.day).toLocaleDateString(undefined, { weekday: 'short' }),
        value: d.orderCount,
      })),
    [daily]
  );

  // Expenses fall on the day they were SPENT (`occurredOn`), not the day the
  // receipt was typed in -- the same field the P&L buckets on, so the two
  // cards cannot disagree about which week a cost belongs to.
  const comparePoints: GroupedBarPoint[] = useMemo(() => {
    const byDay = new Map<string, number>();
    for (const expense of expenses) {
      // `dayKeyFor`, not a date slice. `DailyBucket.day` is a `toDateString()`
      // key ("Thu Aug 06 2026"), so slicing ten characters off each side
      // compared "Thu Aug 06" against "2026-08-06" — a pair that can never
      // match, which drew every expense bar at zero however much was spent.
      const key = dayKeyFor(expense.occurredOn);
      byDay.set(key, (byDay.get(key) ?? 0) + expense.amountCents);
    }
    return daily.map((d) => ({
      label: new Date(d.day).toLocaleDateString(undefined, { weekday: 'short' }),
      a: d.netRevenueCents,
      b: byDay.get(d.day) ?? 0,
    }));
  }, [daily, expenses]);

  // Opening hours belong to a BRANCH, not to the business (migration
  // 20260809000000). For a single store that is simply its own hours; for the
  // combined view it is the union across active stores, which is the honest
  // answer to "when is this business taking money" — the flagship opening an
  // hour before the kiosk means the business is open for that hour.
  const scopeOpeningHours = useMemo<OpeningHours>(() => {
    const active = locations.filter((location) => location.active);
    const scoped = locationFilter === null ? active : active.filter((location) => location.id === locationFilter);
    if (scoped.length === 1) return scoped[0].openingHours ?? {};
    const merged: OpeningHours = {};
    for (const location of scoped) {
      for (const day of WEEK_ORDER) {
        const ranges = location.openingHours?.[day] ?? [];
        if (ranges.length > 0) merged[day] = [...(merged[day] ?? []), ...ranges];
      }
    }
    return merged;
  }, [locations, locationFilter]);

  // The payment mix, relabelled for the hero. Mobile wallets are grouped
  // because "Mobile money" is how a shopkeeper thinks about ZAAD and e-Dahab
  // together -- one question, not two.
  const takingsMethods = useMemo<TakingsMethod[]>(
    () =>
      paymentMix.map((entry) => ({
        label: methodLabel(entry.method),
        amountCents: entry.amountCents,
        group: entry.method === 'cash' ? 'cash' : entry.method === 'zaad' || entry.method === 'edahab' ? 'mobile' : 'other',
      })),
    [paymentMix]
  );
  // Net of tax handed back with refunds: a refunded sale's tax went back over
  // the counter, so it is not "held" and not owed onward. Read off `daily`
  // rather than `rangeSales` so this and `revenueCents` above come from the
  // same buckets -- mixing the two sources is how they drift.
  const salesTaxCents = useMemo(
    () => daily.reduce((sum, d) => sum + d.taxCents - d.refundTaxCents, 0),
    [daily]
  );
  // What was handed back over the counter. Together with the tax above this is
  // the whole of the gap between takings and revenue, which two notes on this
  // screen claim to explain -- and could not, naming only the tax.
  const refundedCents = useMemo(() => daily.reduce((sum, d) => sum + d.refundCents, 0), [daily]);

  // Pace reads the recorded buckets rather than scaling a total: the last
  // bucket IS today, and the last seven ARE this week, whatever range the
  // picker is on.
  const todayCents = daily.length ? daily[daily.length - 1].netRevenueCents : 0;
  const weekCents = useMemo(() => daily.slice(-7).reduce((sum, d) => sum + d.netRevenueCents, 0), [daily]);

  const attention = buildAttentionItems({
    closedSessions,
    openInvoices: money?.openInvoices ?? [],
    recurringBills: money?.recurringBills ?? [],
    budgetRows: money?.budgets ?? [],
    pendingTimeOff: hr?.pendingTimeOff ?? [],
    staleShifts: hr?.staleShifts ?? [],
    onLeave: hr?.onLeave ?? [],
    lowStock,
    expiringSoon,
    dormant,
    ordersNeedingActionCount,
  });

  // Where a global-search hit goes. Each kind lands on the screen that owns
  // it, so a result is a shortcut rather than a hint that something exists.
  // The destinations mirror openAttention's below, and both rely on the same
  // guarantee: every target validates permissions on arrival, so a link can't
  // strand someone on a screen they may not read.
  const openSearchResult = (result: SearchResult) => {
    switch (result.kind) {
      case 'product':
        router.push(`/product/${result.id}`);
        return;
      case 'customer':
        router.push({ pathname: '/people', params: { tab: 'customers' } });
        return;
      case 'staff':
        router.push({ pathname: '/people', params: { tab: 'team' } });
        return;
      case 'sale':
        router.push({ pathname: '/accounting', params: { tab: 'transactions' } });
        return;
      case 'invoice':
        router.push({ pathname: '/accounting', params: { tab: 'invoices' } });
        return;
      case 'expense':
        router.push({ pathname: '/accounting', params: { tab: 'expenses' } });
        return;
    }
  };

  // Where each row goes, down to the tab and the filter. The item's own key is
  // what decides -- an overdue invoice belongs on Bills, a budget on
  // Cash & Budgets -- so a reader lands on the thing the row was about rather
  // than on a screen where they have to find it again.
  //
  // People's tab is validated against permissions on arrival (see people.tsx),
  // so a link can't strand a cashier on an empty tab.
  const openAttention = (item: AttentionItem) => {
    if (item.key === 'invoices-overdue') {
      router.push({ pathname: '/accounting', params: { tab: 'invoices' } });
      return;
    }
    if (item.key.startsWith('bill-') || item.key.startsWith('budget-')) {
      router.push({ pathname: '/accounting', params: { tab: 'cash' } });
      return;
    }
    // A drawer that did not balance lands on Cash & Budgets, where the sessions
    // card is. Without this it fell through to the team roster below, which is
    // the right destination for a time-off row and a baffling one for a $5
    // variance.
    if (item.key.startsWith('register-session-')) {
      // The session id, not just the tab: the row names one short drawer, so
      // landing on a list and making the reader find it again wastes the one
      // thing the row already knew.
      router.push({
        pathname: '/accounting',
        params: { tab: 'cash', session: item.key.replace('register-session-', '') },
      });
      return;
    }
    if (item.key === 'low-stock') {
      router.push({ pathname: '/inventory', params: { filter: 'low' } });
      return;
    }
    if (item.key === 'expiring') {
      router.push({ pathname: '/inventory', params: { filter: 'expiring' } });
      return;
    }
    if (item.key === 'dormant') {
      router.push({ pathname: '/people', params: { tab: 'customers' } });
      return;
    }
    if (item.key === 'storefront-orders') {
      router.push('/orders');
      return;
    }
    router.push({ pathname: '/people', params: { tab: 'team' } });
  };

  return (
    <SafeAreaView edges={['left', 'right', 'bottom']} style={styles.safeArea}>
      {/* `keyboardShouldPersistTaps` belongs HERE, not only on the search
          panel's own list. Responder capture runs ancestors-first, so at the
          default `never` this ScrollView ate the tap to dismiss the keyboard
          and the result rows never saw it — and the blur it caused closed the
          panel, so there was no second tap to give. `handled` and not
          `always`: a tap no child claims still dismisses the keyboard, which
          is what closes the panel when you tap the page. */}
      <ScrollView
        ref={scrollRef}
        contentContainerStyle={styles.content}
        refreshControl={pullToRefresh}
        keyboardShouldPersistTaps="handled"
      >
        <DashboardPageHeader onSelectResult={openSearchResult} />

        <GreetingBand
          summary={summarySentence({
            netProfitCents: pnl.netProfitCents,
            revenueCents,
            cogsCents: pnl.cogsCents,
            operatingExpenseCents: pnl.operatingCents,
            uncostedItemCount: cogs?.uncostedItemCount ?? 0,
          })}
          attentionCount={attention.length}
          onShowTasks={scrollToAttention}
        />

        {/* Date and store, as a matched pair of pills. Shared with Accounting
            so the two screens can't drift apart again. */}
        <View style={styles.controlRow}>
          <BentoControlBar
            presets={DASHBOARD_PRESETS}
            initialDays={7}
            onRangeChange={setDateRange}
            locationFilter={locationFilter}
            onLocationChange={setLocationFilter}
          />
        </View>

        {error && <Text style={styles.error}>{error}</Text>}

        {/* rowAlign=stretch: the Overview strip reads as ONE band, and five
            cards answering one question at five different heights reads as
            five leftovers rather than a row. */}
        <BentoGrid rowAlign="stretch" onLayout={(event) => { gridOffset.current = event.nativeEvent.layout.y; }}>
          {/* Travels with the figure rather than sitting in a footnote:
              without it, gross profit reads as precise when it is knowably
              overstated. */}
          {cogs && cogs.uncostedItemCount > 0 && !uncostedNote.dismissed ? (
            <BentoCell span={12}>
              <Caveat
                tone="wrong"
                action={{ label: 'Set costs in Inventory', onPress: () => router.push({ pathname: '/inventory', params: { filter: 'nocost' } }) }}
                onDismiss={uncostedNote.dismiss}
              >
                {`${cogs.uncostedItemCount} sold ${cogs.uncostedItemCount === 1 ? 'item has' : 'items have'} no cost recorded (${formatAccountingCents(cogs.uncostedRevenueCents)} of revenue), so gross profit looks higher than it is.`}
              </Caveat>
            </BentoCell>
          ) : null}

          {/* No zone label above the caveat: it is a banner, not a card, and a
              heading over a single warning reads as ceremony. */}
          <BentoZone>Overview</BentoZone>

          {/* The dark card, and the only one. It answers what this screen
              never could -- how much came through the till -- which is not
              revenue: the gap is tax that was never the shop's. */}
          <BentoCell span={3}>
            <TakingsHeroCard
              methods={takingsMethods}
              revenueCents={revenueCents}
              expenseCents={pnl.operatingCents}
              taxCents={salesTaxCents}
              refundedCents={refundedCents}
              canSeeExpenses={canSeeExpenses}
              onSeeProfitAndLoss={scrollToProfitAndLoss}
            />
          </BentoCell>

          <BentoCell span={3}>
            <IncomePaidCard
              revenueCents={revenueCents}
              expenseCents={pnl.operatingCents}
              previousRevenueCents={prior?.revenueCents ?? null}
              previousExpenseCents={prior?.expenseCents ?? null}
              canSeeExpenses={canSeeExpenses}
              scope={rangeLabel}
            />
          </BentoCell>

          {/* minCard=MIN_TILE on the three small cells, and only on these: a
              ring, a dot field and a sparkline hold at 184 where a card of
              headings and captions does not. Judged against the 240 every card
              gets, all three stepped up to a third on a 1508pt window and the
              band that reads as one strip spilled onto a second row. */}
          {canSeeExpenses ? (
            <BentoCell span={2} minCard={MIN_TILE}>
              <MarginGaugeCard netProfitCents={pnl.netProfitCents} revenueCents={revenueCents} />
            </BentoCell>
          ) : null}

          {/* Two small cards in one cell, as the design stacks them. Not
              `fill` on either: forcing them to split the row height gave the
              goal less room than its meter and caption needed. */}
          <BentoCell span={2} minCard={MIN_TILE}>
            <View style={styles.stack}>
              {cogs ? (
                <CostedProductsCard soldCount={products.length} uncostedCount={cogs.uncostedItemCount} />
              ) : null}
              {/* No scope pill and no title: the caption says "monthly goal"
                  in words, which is the same fact a "This month" pill carried
                  and one less thing in a card this small. The goal is a
                  calendar-month commitment either way — it never follows the
                  range selector. */}
              {goalCents ? (
                <RevenueGoalCard
                  monthToDateCents={monthToDateCents}
                  goalCents={goalCents}
                  daysLeftInMonth={daysLeftInMonth()}
                  onEdit={() => router.push('/settings')}
                />
              ) : null}
            </View>
          </BentoCell>

          <BentoCell span={2} minCard={MIN_TILE}>
            <RevenueSparkCard
              revenueCents={revenueCents}
              dailyCents={daily.map((d) => d.netRevenueCents)}
              orderCount={orderCount}
              netProfitCents={pnl.netProfitCents}
              scope={rangeLabel}
            />
          </BentoCell>

          {/* Span 12, not 8. Six tiles in one clean row is the whole form of
              this strip, and at eight columns the last two wrapped onto a
              second line beside a gap where nothing sat. */}
          <BentoCell span={12}>
            <Card variant="bento" style={styles.card}>
              <View style={styles.cardHead}>
                <Text style={styles.cardTitle}>This period at a glance</Text>
                <Text style={styles.scopePill}>{rangeLabel}</Text>
              </View>
              <View style={styles.metricRow}>
                {/* Revenue, Expenses and Net margin are deliberately absent:
                    all three are stated at full size in the Overview row
                    above, and printing the same figures twice on one screen is
                    how a dashboard stops being read. Six figures nobody has
                    stated yet, one row.
                    "Customers to check on" is not here for the same reason —
                    it is already a row in Needs attention below. */}
                {cogs && <StatTile variant="bento" value={formatCompactCents(grossProfitCents)} label="Gross profit" />}
                {canSeeExpenses && (
                  <StatTile variant="bento"
                    value={formatCompactCents(pnl.netProfitCents)}
                    label="Net profit"
                    tone={pnl.netProfitCents < 0 ? 'warning' : 'positive'}
                    // Only when the two windows were computed the same way.
                    // The prior window's accrued wages are never fetched, so
                    // once this period carries an accrual the comparison would
                    // be against a figure that excludes one — a badge that
                    // reports a fall the shop did not have.
                    badge={
                      pnl.accruedLaborCents === 0 ? (
                        <DeltaBadge current={pnl.netProfitCents} previous={prior?.netProfitCents} />
                      ) : undefined
                    }
                  />
                )}
                <StatTile
                  variant="bento"
                  value={String(orderCount)}
                  label="Orders"
                  badge={<DeltaBadge current={orderCount} previous={prior?.orderCount} />}
                />
                <StatTile
                  variant="bento"
                  value={formatCompactCents(orderCount ? Math.round(revenueCents / orderCount) : 0)}
                  label="Average sale"
                />
                <StatTile variant="bento" value={formatCompactCents(salesTaxCents)} label="Sales tax held" hint="owed onward, not yours" />
                {canSeeTeam && hr && (
                  <StatTile variant="bento" value={`${hr.activeToday}/${hr.teamTotal}`} label="Team on today" />
                )}
              </View>
              {/* "by exactly this much" was a checkable claim, and on a range
                  with refunds it did not check out: takings ran ahead of
                  revenue by the tax AND the refunds. Says both, or neither. */}
              <Text style={styles.cardFoot}>
                {refundedCents > 0
                  ? `Sales tax is collected for the authority and is not yours to spend. Takings above run ahead of revenue by this and by the ${formatAccountingCents(refundedCents)} refunded in the range.`
                  : 'Sales tax is collected for the authority and is not yours to spend — which is why takings above exceed revenue by exactly this much.'}
              </Text>
            </Card>
          </BentoCell>


          {/* Am I on track — asked at three horizons. Only rendered where a
              goal exists, like the meter above: three rings all reading 0%
              of nothing is worse than no card. */}
          {goalCents ? (
            <BentoCell span={12}>
              <SalesPaceCard
                todayCents={todayCents}
                weekCents={weekCents}
                monthToDateCents={monthToDateCents}
                monthlyGoalCents={goalCents}
                daysLeftInMonth={daysLeftInMonth()}
              />
            </BentoCell>
          ) : null}

          <BentoZone>Profit &amp; loss</BentoZone>

          {/* The P&L and the waterfall pair deliberately: the statement
              reconciles to the cent, the chart shows what ate the revenue.
              Neither answers the other's question. */}
          {canSeeExpenses ? (
            <BentoCell span={5} onLayout={(event) => { plOffset.current = event.nativeEvent.layout.y; }}>
              <Card variant="bento" style={styles.card}>
                <View style={styles.cardHead}>
                  <Text style={styles.cardTitle}>Profit &amp; loss</Text>
                  <Text style={styles.scopePill}>{rangeLabel}</Text>
                </View>
                <StatementRow label="Revenue" hint="net of sales tax and refunds" amountCents={pnl.revenueCents} />
                <StatementRow label="Cost of goods sold" hint="what the items sold cost you" amountCents={-pnl.cogsCents} />
                <StatementRow label="Gross profit" amountCents={pnl.grossProfitCents} variant="emphasis" />
                <StatementRow
                  label="Operating expenses"
                  hint="excludes stock purchases and owner draws"
                  amountCents={-pnl.postedOperatingCents}
                />
                {pnl.accruedLaborCents > 0 && (
                  <StatementRow label="Wages earned, not yet paid" hint="no pay run posted yet" amountCents={-pnl.accruedLaborCents} />
                )}
                <StatementRow label="Net profit" amountCents={pnl.netProfitCents} variant="total" />
                {!canSeeLabor && !noPayrollNote.dismissed && (
                  <Caveat tone="partial" onDismiss={noPayrollNote.dismiss}>
                    Wages aren&apos;t included — you don&apos;t have payroll access, so this profit figure leaves out labour costs.
                  </Caveat>
                )}
              </Card>
            </BentoCell>
          ) : null}

          {canSeeExpenses ? (
            <BentoCell span={7}>
              <Card variant="bento" style={styles.card}>
                <View style={styles.cardHead}>
                  <Text style={styles.cardTitle}>How revenue becomes profit</Text>
                  <Text style={styles.scopePill}>{rangeLabel}</Text>
                </View>
                <WaterfallChart
                  formatValue={formatCompactCents}
                  steps={[
                    { label: 'Revenue', value: pnl.revenueCents, total: true },
                    { label: 'Cost of goods', sub: 'what stock cost', value: -pnl.cogsCents },
                    { label: 'Gross profit', value: pnl.grossProfitCents, total: true },
                    { label: 'Operating exp.', sub: 'wages, rent, power', value: -pnl.operatingCents },
                    { label: 'Net profit', value: pnl.netProfitCents, total: true },
                  ]}
                />
                <Text style={styles.cardFoot}>
                  Green and red are backed by the signed figure on every bar — the colour alone
                  never carries the meaning.
                </Text>
              </Card>
            </BentoCell>
          ) : null}

          <BentoZone>What is selling</BentoZone>

          {products.length > 0 ? (
            <BentoCell span={12}>
              <BestSellersCard products={products.slice(0, BEST_SELLER_LIMIT)} rangeLabel={rangeLabel} />
            </BentoCell>
          ) : null}

          {/* Four columns each, not three: dropping the reference's fourth
              "inventory at a glance" tile left a gap, and its three figures
              are already on this screen -- the uncosted count in the caveat
              above, low stock in Needs attention below. */}
          {movers.map((mover, index) => (
            <BentoCell key={`${mover.productId ?? 'gone'}:${mover.name}`} span={3}>
              <TopMoverCard
                mover={mover}
                rank={MOVER_RANKS[index] ?? 'Also moving'}
                rangeLabel={rangeLabel}
                shareOfRevenue={productRevenueCents > 0 ? (mover.revenueCents / productRevenueCents) * 100 : 0}
                dailyCents={
                  dateRange ? productDailyRevenue(rangeSales, mover, dateRange.since, dateRange.until) : []
                }
              />
            </BentoCell>
          ))}

          {/* Completes the row of four. Three products is not inventory --
              without this the reader learns what moved and has nowhere to
              go with it. */}
          {movers.length > 0 ? (
            <BentoCell span={3}>
              <InventoryGlanceCard
                productsSold={products.length}
                uncostedCount={cogs?.uncostedItemCount ?? 0}
                lowStockCount={lowStock.length}
                onSetCosts={() => router.push({ pathname: '/inventory', params: { filter: 'nocost' } })}
                onReviewLowStock={() => router.push({ pathname: '/inventory', params: { filter: 'low' } })}
              />
            </BentoCell>
          ) : null}

          <BentoZone>Trends</BentoZone>

          {rangeSales.length > 0 ? (
            <BentoCell span={12}>
              <OpenHoursCard
                sales={rangeSales}
                daily={daily}
                monthDaily={monthDaily}
                openingHours={scopeOpeningHours}
                rangeLabel={rangeLabel}
              />
            </BentoCell>
          ) : null}

          <BentoCell span={7}>
            <Card variant="bento" style={styles.card}>
              <View style={styles.cardHead}>
                <Text style={styles.cardTitle}>Revenue</Text>
                <Text style={styles.scopePill}>{rangeLabel}</Text>
              </View>
              <TrendChart data={trendData} formatValue={formatCompactCents} showAxis />
              {revenuePeak ? (
                <Text style={styles.cardFoot}>
                  {`${revenuePeak.label} is the range's peak at ${formatAccountingCents(revenuePeak.cents)}. ` +
                    `Net of sales tax and refunds, so this line matches the revenue row in the P&L above.`}
                </Text>
              ) : null}
            </Card>
          </BentoCell>

          {/* Beside revenue on purpose. A strong revenue day on fewer, larger
              baskets is a different day from a strong one on more of them,
              and only the pair says which happened. */}
          <BentoCell span={5}>
            <Card variant="bento" style={styles.card}>
              <View style={styles.cardHead}>
                <Text style={styles.cardTitle}>Orders</Text>
                <Text style={styles.scopePill}>{rangeLabel}</Text>
              </View>
              <BarChart data={orderPoints} formatValue={(value) => String(Math.round(value))} />
              <Text style={styles.cardFoot}>
                {`${orderCount} ${orderCount === 1 ? 'order' : 'orders'} · ${formatAccountingCents(orderCount ? Math.round(revenueCents / orderCount) : 0)} average sale`}
              </Text>
            </Card>
          </BentoCell>

          {canSeeExpenses ? (
            <BentoCell span={7}>
              <Card variant="bento" style={styles.card}>
                <View style={styles.cardHead}>
                  <Text style={styles.cardTitle}>Revenue vs. expenses</Text>
                  <Text style={styles.scopePill}>{rangeLabel}</Text>
                </View>
                <GroupedBarChart
                  data={comparePoints}
                  formatValue={formatCompactCents}
                  labelA="Revenue"
                  labelB="Expenses"
                />
                <View style={styles.legendRow}>
                  <Legend color={theme.bentoSeries1} label="Revenue" />
                  <Legend color={theme.bentoSeries3} label="Expenses" />
                </View>
                <Text style={styles.cardFoot}>
                  Expenses sit on the day they were spent, not the day the receipt was entered — so a
                  wage run shows as the spike it is rather than spread across the week.
                </Text>
              </Card>
            </BentoCell>
          ) : null}

          <BentoCell span={canSeeExpenses ? 5 : 12}>
            <Card variant="bento" style={styles.card}>
              <View style={styles.cardHead}>
                <Text style={styles.cardTitle}>Payment methods</Text>
                <Text style={styles.scopePill}>{rangeLabel}</Text>
              </View>
              <PaymentMixChart items={paymentMix} formatValue={formatAccountingCents} />
              <View style={styles.legendRow}>
                <Legend color={theme.bentoSeries1} label="Cash" />
                <Legend color={theme.bentoSeries2} label="ZAAD" />
                <Legend color={theme.bentoSeries3} label="e-Dahab" />
                <Legend color={theme.bentoSeries4} label="Other" />
              </View>
              {/* The one card on this screen that does NOT sum to revenue, so
                  it says so rather than leaving a reader to reconcile it
                  against the P&L and find a gap the size of the tax. */}
              <Text style={styles.cardFoot}>
                {`Sums to takings (${formatAccountingCents(takingsCents)}), not revenue — this is money collected, tax included.`}
              </Text>
            </Card>
          </BentoCell>

          <BentoZone>Who is behind the numbers</BentoZone>

          {cashiers.length > 0 ? (
            <BentoCell span={6}>
              <LeaderboardCard
                title="Top performers"
                scope={rangeLabel}
                entries={cashiers}
                emptyLabel="No sales are attributed to a cashier in this range."
                // Says refunds too, not just tax. `cashierPerformance` ranks
                // what was rung up -- deliberately, since this is a staff
                // question -- but a range where a third of the takings came
                // back makes "gross of tax" alone a half-answer.
                foot="Attribution is the cashier name frozen on each sale, so it survives someone leaving. Gross of tax and of refunds, like a till reading."
              />
            </BentoCell>
          ) : null}

          {canSeeCustomers && topCustomers.length > 0 ? (
            <BentoCell span={6}>
              <LeaderboardCard
                title="Top customers"
                // NOT the range pill. getCustomersStatsBatch is lifetime, and
                // two identical strips over different windows is the easiest
                // way for this screen to mislead.
                scope="All time"
                entries={topCustomers}
                emptyLabel="No sales have been linked to a customer yet."
                foot="Lifetime spend, net of anything returned, so this one does not follow the date range."
              />
            </BentoCell>
          ) : null}

          <BentoZone>Needs you</BentoZone>

          {money && (money.openInvoices.length > 0 || money.recurringBills.length > 0) ? (
            <BentoCell span={6}>
              <Card variant="bento" style={styles.card}>
                <View style={styles.cardHead}>
                  <Text style={styles.cardTitle}>Money going out</Text>
                  {/* These figures deliberately ignore the range — what you
                      owe is a fact about now, which invoice-reporting.ts
                      already insists on. */}
                  <Text style={styles.scopePill}>As of today</Text>
                </View>
                <StatementRow label="Owed to suppliers" hint={`${owed.openCount} open ${owed.openCount === 1 ? 'bill' : 'bills'}`} amountCents={owed.outstandingCents} />
                {owed.overdueCents > 0 && <StatementRow label="of that, overdue" variant="sub" amountCents={owed.overdueCents} />}
                <StatementRow label="Committed every month" hint="active recurring bills" amountCents={monthlyCommitmentCents} variant="emphasis" last />
                <Text style={styles.cardFoot}>
                  These figures deliberately ignore the range above — what you owe is a fact about
                  now, not about the window the rest of this screen is showing.
                </Text>
              </Card>
            </BentoCell>
          ) : null}

          <BentoCell
            span={6}
            onLayout={(event) => { attentionOffset.current = event.nativeEvent.layout.y; }}
          >
            <Card variant="bento" style={styles.card}>
              <View style={styles.cardHead}>
                <Text style={styles.cardTitle}>Needs attention</Text>
                {/* The count, not "As of today". Every other card on this
                    screen is scoped by a window; this one is scoped by how
                    much there is, and the number is the thing a reader wants
                    before they decide to look. */}
                <Text style={styles.scopePill}>
                  {`${attention.length} ${attention.length === 1 ? 'item' : 'items'}`}
                </Text>
              </View>
              <AttentionList items={attention} onSelect={openAttention} />
              <Text style={styles.cardFoot}>
                Ordered by what blocks someone or costs money today, not by area. The severity
                stripe repeats that ordering in form, so urgency survives a greyscale print.
              </Text>
            </Card>
          </BentoCell>

          {/* Span 12, not 6: DataTable manages its own horizontal scroll and
              gutters, and a half-width cell squeezed three columns into ~360px
              on a laptop. A table wants the width. */}
          {lowStock.length > 0 && (
            <BentoCell span={12}>
            {/* A table, not tiles. The question here is comparative -- units
                left against the level that triggers a reorder -- and tiles
                force each product to be read on its own. */}
            <Card variant="bento" style={styles.tableCard}>
              <View style={[styles.cardHead, styles.tableHead]}>
                <Text style={styles.cardTitle}>Low stock</Text>
                <Text style={styles.scopePill}>As of today</Text>
              </View>
              <DataTable
                rows={lowStock.slice(0, 5)}
                keyExtractor={(product) => product.id}
                onRowPress={(product) => router.push(`/product/${product.id}`)}
                emptyLabel="Nothing is running low."
                minWidth={420}
                columns={[
                  {
                    key: 'product',
                    header: 'Product',
                    render: (product) => (
                      <NameCell title={product.name} meta={[product.category, product.sku].filter(Boolean).join(' · ')} />
                    ),
                  },
                  {
                    key: 'left',
                    header: 'Left',
                    numeric: true,
                    width: 66,
                    render: (product) => (
                      <ValueCell
                        value={String(product.stock)}
                        strong
                        tone={product.stock <= 0 ? 'danger' : 'warning'}
                      />
                    ),
                  },
                  {
                    key: 'reorder',
                    header: 'Reorder at',
                    numeric: true,
                    width: 92,
                    render: (product) => (
                      <ValueCell value={String(product.reorderLevel ?? shop?.defaultLowStockLevel ?? 0)} tone="muted" />
                    ),
                  },
                ]}
              />
            </Card>
            </BentoCell>
          )}

          {expiringSoon.length > 0 && (
            <BentoCell span={12}>
            <Card variant="bento" style={styles.tableCard}>
              <View style={[styles.cardHead, styles.tableHead]}>
                <Text style={styles.cardTitle}>Expiring soon</Text>
                <Text style={styles.scopePill}>As of today</Text>
              </View>
              <DataTable
                rows={expiringSoon.slice(0, 5)}
                keyExtractor={(product) => product.id}
                onRowPress={(product) => router.push(`/product/${product.id}`)}
                emptyLabel="Nothing is expiring soon."
                minWidth={420}
                columns={[
                  {
                    key: 'product',
                    header: 'Product',
                    render: (product) => <NameCell title={product.name} meta={product.category ?? undefined} />,
                  },
                  {
                    key: 'expires',
                    header: 'Expires',
                    numeric: true,
                    width: 104,
                    render: (product) => <ValueCell value={formatExpiry(product.expiryDate)} tone="warning" strong />,
                  },
                  {
                    key: 'units',
                    header: 'Units',
                    numeric: true,
                    width: 62,
                    render: (product) => <ValueCell value={String(product.stock)} tone="muted" />,
                  },
                ]}
              />
            </Card>
            </BentoCell>
          )}
          <BentoZone>Latest sales</BentoZone>

          {recentSales.length > 0 && (
            <BentoCell span={12}>
              <Card variant="bento" style={styles.card}>
                <View style={styles.cardHead}>
                  <Text style={styles.cardTitle}>Recent transactions</Text>
                  <Text style={styles.scopePill}>Latest {recentSales.length}</Text>
                </View>
                {recentSales.map((sale, index) => (
                  <View
                    key={sale.id}
                    style={[styles.recentRow, index === recentSales.length - 1 && styles.recentRowLast]}
                  >
                    <Text style={styles.recentName} numberOfLines={1}>
                      {sale.items?.map((item) => item.productName).join(', ') || 'Sale'}
                    </Text>
                    {/* The middle column. Across the full width a name and a
                        number sit at opposite ends of the screen with nothing
                        between them, and the sale already carries the time. */}
                    <Text style={styles.recentTime}>
                      {new Date(sale.createdAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}
                    </Text>
                    <Text style={styles.recentAmount}>{formatAccountingCents(sale.totalCents)}</Text>
                  </View>
                ))}
                <Text style={styles.cardFoot}>
                  Gross of tax, like a till reading — the same figure the customer was charged, not
                  the revenue it becomes in the P&amp;L.
                </Text>
              </Card>
            </BentoCell>
          )}

        </BentoGrid>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  // The grey page the cards float on — the one place the bento palette
  // replaces the cream `background` the rest of the app still uses.
  safeArea: { flex: 1, backgroundColor: theme.bentoPage },
  content: { padding: 18, paddingBottom: 42 },
  controlRow: { marginBottom: 16 },
  card: { padding: 18 },
  // Less horizontal padding: DataTable manages its own gutters, and doubling
  // them squeezes the columns.
  tableCard: { paddingHorizontal: 10, paddingVertical: 14 },
  cardHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 12 },
  tableHead: { paddingHorizontal: 8 },
  cardTitle: { fontSize: 15, fontWeight: '800', letterSpacing: -0.2, color: theme.bentoInk, flexShrink: 1 },
  // Says what window the figures beside it cover. Not decoration: the goal
  // meter is a calendar month and the attention list is "right now", while
  // everything else follows the range picker — without this the reader has to
  // assume, and would assume wrong.
  scopePill: {
    fontSize: 12,
    fontWeight: '700',
    color: theme.bentoInk2,
    borderWidth: 1,
    borderColor: theme.bentoLine,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 5,
    overflow: 'hidden',
  },
  metricRow: { flexDirection: 'row', gap: 10, flexWrap: 'wrap' },
  // Two cards sharing one cell. No flex on the children -- forcing them to
  // split the row height gave the goal less room than its meter needed.
  stack: { gap: 14 },
  cardFoot: { fontSize: 11.5, color: theme.bentoMuted, marginTop: 10, lineHeight: 17 },
  legendRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 16, marginTop: 8 },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  legendDot: { width: 9, height: 9, borderRadius: 5 },
  legendLabel: { fontSize: 11.5, color: theme.bentoMuted, fontWeight: '600' },
  // Three columns, baseline-aligned: what sold, when, and for how much. The
  // amount takes a fixed width so the figures form a column that can be
  // scanned down rather than sitting wherever each name happens to end.
  recentRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 14,
    paddingVertical: 9,
    borderBottomWidth: 1,
    borderBottomColor: theme.bentoLine,
  },
  recentRowLast: { borderBottomWidth: 0 },
  recentName: { flex: 1, minWidth: 0, fontSize: 13, fontWeight: '600', color: theme.bentoInk },
  recentTime: { fontSize: 11.5, color: theme.bentoMuted, fontVariant: ['tabular-nums'] },
  recentAmount: {
    width: 92,
    textAlign: 'right',
    fontSize: 13,
    fontWeight: '800',
    color: theme.bentoInk,
    fontVariant: ['tabular-nums'],
  },
  error: { color: theme.bentoLoss, fontSize: 12, fontWeight: '700', marginBottom: 12 },
});
