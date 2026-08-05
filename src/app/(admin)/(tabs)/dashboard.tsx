import { useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AttentionList } from '@/components/attention-list';
import { Card } from '@/components/card';
import { GreetingBand, summarySentence } from '@/components/dashboard/greeting-band';
import { DashboardPageHeader } from '@/components/dashboard/page-header';
import { GoalMeter } from '@/components/goal-meter';
import { PaymentMixChart, type PaymentMixItem } from '@/components/payment-mix-chart';
import { type DateRange, type RangePreset } from '@/components/range-selector';
import { StatTile } from '@/components/stat-tile';
import { TrendChart, type TrendPoint } from '@/components/trend-chart';
import { WaterfallChart } from '@/components/waterfall-chart';
import { BentoCell, BentoGrid } from '@/components/ui/bento';
import { BentoControlBar } from '@/components/ui/bento-control-bar';
import { Caveat } from '@/components/ui/caveat';
import { DataTable, NameCell, ValueCell } from '@/components/ui/data-table';
import { StatementRow } from '@/components/ui/statement-row';
import { Colors } from '@/constants/theme';
import { useAuth } from '@/hooks/use-auth';
import { buildAttentionItems, type AttentionItem } from '@/lib/attention';
import { budgetRows, monthlyBillCommitmentCents, type BudgetRow } from '@/lib/cash-budget-reporting';
import { listBudgets, listRecurringBills } from '@/lib/cash-budgets';
import { formatAccountingCents, formatCompactCents } from '@/lib/currency';
import { dormantCustomers, getCustomersStatsBatch, listCustomers } from '@/lib/customers';
import { listExpensesInRange } from '@/lib/expenses';
import { invoiceTotals } from '@/lib/invoice-reporting';
import { listOpenInvoices } from '@/lib/invoices';
import { scopeToLocation } from '@/lib/location-reporting';
import { hasMultipleLocations } from '@/lib/location-selection';
import { listPayrollRuns } from '@/lib/payroll';
import { accruedLaborCents } from '@/lib/payroll-reporting';
import { profitAndLoss } from '@/lib/pnl';
import { getExpiringProducts, getLowStockProducts } from '@/lib/products';
import type { SearchResult } from '@/lib/search';
import { getDailyTotalsCents, getMonthToDateRevenueCents, getSalesAndRefundsInRange, listSales } from '@/lib/sales';
import { costOfGoodsSold, paymentMethodMix, type CogsResult, type DailyBucket } from '@/lib/sales-reporting';
import { membersActiveToday, onLeaveMemberIds, staleOpenShifts } from '@/lib/shift-hours';
import { listStaff } from '@/lib/staff';
import { listShopTimeEntries } from '@/lib/time-entries';
import { listShopTimeOffRequests } from '@/lib/time-off';
import type { Customer, Expense, Invoice, Product, RecurringBill, Sale, StaffMember, TimeEntry, TimeOffRequest } from '@/types/models';

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

type HrSnapshot = {
  activeToday: number;
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
  const { shop, can, locations, activeLocation } = useAuth();
  const showLocationName = hasMultipleLocations(locations);
  // Time and leave data is RLS-protected; without these the queries would just
  // fail, so the rows are left out rather than erroring the whole screen.
  const canSeeTeam = can('people.timesheet.view');
  const canApproveTimeOff = can('people.timeoff.approve');
  const canSeeExpenses = can('expenses.view');
  const canSeeCustomers = can('customers.view');
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
  const [dormant, setDormant] = useState<{ customer: Customer; lastOrderAt: string }[]>([]);
  const [recentSales, setRecentSales] = useState<Sale[]>([]);
  const [hr, setHr] = useState<HrSnapshot | null>(null);
  const [money, setMoney] = useState<MoneySnapshot | null>(null);
  const [cogs, setCogs] = useState<CogsResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<ScrollView>(null);
  const gridOffset = useRef<number | null>(null);
  const attentionOffset = useRef<number | null>(null);

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
  }, [shop, dateRange, locationFilter, canSeeExpenses, canSeeCustomers, canSeeTeam, canApproveTimeOff, canSeeLabor]);

  useEffect(() => { reload(); }, [reload]);

  // The goal is a calendar-month commitment, so it stays independent of
  // whatever range is selected above.
  useEffect(() => {
    if (!shop) return;
    // Scoped to the same store the goal belongs to, so the meter compares like
    // with like.
    getMonthToDateRevenueCents(shop.id, locationFilter).then(setMonthToDateCents);
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

  const owed = useMemo(() => invoiceTotals(money?.openInvoices ?? []), [money]);
  const monthlyCommitmentCents = useMemo(
    () => monthlyBillCommitmentCents(money?.recurringBills ?? []),
    [money]
  );

  const scopeName = useMemo(() => {
    if (locationFilter === null) return 'All stores';
    return locations.find((location) => location.id === locationFilter)?.name ?? 'This store';
  }, [locations, locationFilter]);

  // "Show my tasks" jumps to the Needs attention card. The offset is captured
  // from the cell's own onLayout rather than measured on demand: measure() is
  // asynchronous and inconsistent across native and web, while the layout
  // event is already fired for us and is exact.
  const scrollToAttention = () => {
    if (attentionOffset.current === null || gridOffset.current === null) return;
    // Two offsets summed: the cell reports its position inside the grid, and
    // the grid reports its own inside the scroll content. Either alone lands
    // in the wrong place.
    const target = gridOffset.current + attentionOffset.current;
    // A little above the card, so its heading isn't flush against the top.
    scrollRef.current?.scrollTo({ y: Math.max(0, target - 16), animated: true });
  };

  const rangeLabel = useMemo(() => {
    if (!dateRange) return '';
    const preset = DASHBOARD_PRESETS.find((option) => {
      const start = new Date();
      start.setDate(start.getDate() - (option.days - 1));
      start.setHours(0, 0, 0, 0);
      return !dateRange.until && start.getTime() === dateRange.since.getTime();
    });
    if (preset) return preset.label;
    const until = dateRange.until ?? new Date();
    const short = (date: Date) => date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
    return `${short(dateRange.since)} – ${short(until)}`;
  }, [dateRange]);

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

  const attention = buildAttentionItems({
    openInvoices: money?.openInvoices ?? [],
    recurringBills: money?.recurringBills ?? [],
    budgetRows: money?.budgets ?? [],
    pendingTimeOff: hr?.pendingTimeOff ?? [],
    staleShifts: hr?.staleShifts ?? [],
    onLeave: hr?.onLeave ?? [],
    lowStock,
    expiringSoon,
    dormant,
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
    router.push({ pathname: '/people', params: { tab: 'team' } });
  };

  return (
    <SafeAreaView edges={['left', 'right', 'bottom']} style={styles.safeArea}>
      <ScrollView ref={scrollRef} contentContainerStyle={styles.content}>
        <DashboardPageHeader onSelectResult={openSearchResult} />

        <GreetingBand
          summary={summarySentence({
            netProfitCents: pnl.netProfitCents,
            revenueCents,
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

        <BentoGrid onLayout={(event) => { gridOffset.current = event.nativeEvent.layout.y; }}>
          {/* Travels with the figure rather than sitting in a footnote:
              without it, gross profit reads as precise when it is knowably
              overstated. */}
          {cogs && cogs.uncostedItemCount > 0 ? (
            <BentoCell span={12}>
              <Caveat
                tone="wrong"
                action={{ label: 'Set costs in Inventory', onPress: () => router.push({ pathname: '/inventory', params: { filter: 'nocost' } }) }}
              >
                {`${cogs.uncostedItemCount} sold ${cogs.uncostedItemCount === 1 ? 'item has' : 'items have'} no cost recorded (${formatAccountingCents(cogs.uncostedRevenueCents)} of revenue), so gross profit looks higher than it is.`}
              </Caveat>
            </BentoCell>
          ) : null}

          {/* The P&L and the waterfall pair deliberately: the statement
              reconciles to the cent, the chart shows what ate the revenue.
              Neither answers the other's question. */}
          {canSeeExpenses ? (
            <BentoCell span={5}>
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
                {!canSeeLabor && (
                  <Caveat tone="partial">
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
              </Card>
            </BentoCell>
          ) : null}

          <BentoCell span={canSeeExpenses ? 8 : 12}>
            <Card variant="bento" style={styles.card}>
              <View style={styles.cardHead}>
                <Text style={styles.cardTitle}>This period at a glance</Text>
                <Text style={styles.scopePill}>{rangeLabel}</Text>
              </View>
              <View style={styles.metricRow}>
                {/* Net of sales tax and refunds — tax collected is the
                    government's money, so it was never revenue. */}
                <StatTile value={formatCompactCents(revenueCents)} label="Revenue" sparkline={daily.map((d) => d.netRevenueCents)} />
                {cogs && <StatTile value={formatCompactCents(grossProfitCents)} label="Gross profit" />}
                {canSeeExpenses && <StatTile value={formatCompactCents(pnl.operatingCents)} label="Expenses" hint="operating" />}
                {canSeeExpenses && (
                  <StatTile
                    value={formatCompactCents(pnl.netProfitCents)}
                    label="Net profit"
                    tone={pnl.netProfitCents < 0 ? 'warning' : 'positive'}
                  />
                )}
                <StatTile value={String(orderCount)} label="Orders" />
                {canSeeCustomers && (
                  <StatTile
                    value={String(dormant.length)}
                    label="Customers to check on"
                    tone={dormant.length > 0 ? 'warning' : 'default'}
                  />
                )}
                {canSeeTeam && hr && <StatTile value={String(hr.activeToday)} label="Team active today" />}
              </View>
            </Card>
          </BentoCell>

          {goalCents ? (
            <BentoCell span={4}>
              <Card variant="bento" style={styles.card}>
                <View style={styles.cardHead}>
                  {/* Named whenever there is a choice to have made, because
                      the goal and the revenue behind it are BOTH the selected
                      store's — an unlabelled meter reads as the whole
                      business's. */}
                  <Text style={styles.cardTitle}>
                    {showLocationName ? `Revenue goal · ${scopeName}` : 'Revenue goal'}
                  </Text>
                  {/* NOT the range pill. The goal is a calendar-month
                      commitment and getMonthToDateRevenueCents ignores the
                      selector entirely, so saying "7 days" here would be a
                      lie about the figure beside it. */}
                  <Text style={styles.scopePill}>This month</Text>
                </View>
                <GoalMeter valueCents={monthToDateCents} goalCents={goalCents} />
              </Card>
            </BentoCell>
          ) : null}

          <BentoCell span={7}>
            <Card variant="bento" style={styles.card}>
              <View style={styles.cardHead}>
                <Text style={styles.cardTitle}>Revenue</Text>
                <Text style={styles.scopePill}>{rangeLabel}</Text>
              </View>
              <TrendChart data={trendData} formatValue={formatCompactCents} showAxis />
            </Card>
          </BentoCell>

          <BentoCell span={5}>
            <Card variant="bento" style={styles.card}>
              <View style={styles.cardHead}>
                <Text style={styles.cardTitle}>Payment methods</Text>
                <Text style={styles.scopePill}>{rangeLabel}</Text>
              </View>
              <PaymentMixChart items={paymentMix} formatValue={formatAccountingCents} />
            </Card>
          </BentoCell>

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
                <StatementRow label="Committed every month" hint="active recurring bills" amountCents={monthlyCommitmentCents} variant="emphasis" />
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
                <Text style={styles.scopePill}>As of today</Text>
              </View>
              <AttentionList items={attention} onSelect={openAttention} />
            </Card>
          </BentoCell>

          {lowStock.length > 0 && (
            <BentoCell span={6}>
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

          {recentSales.length > 0 && (
            <BentoCell span={6}>
              <Card variant="bento" style={styles.card}>
                <View style={styles.cardHead}>
                  <Text style={styles.cardTitle}>Recent transactions</Text>
                  <Text style={styles.scopePill}>Latest {recentSales.length}</Text>
                </View>
                {recentSales.map((sale) => (
                  <View key={sale.id} style={styles.recentRow}>
                    <Text style={styles.recentName} numberOfLines={1}>
                      {sale.items?.map((item) => item.productName).join(', ') || 'Sale'}
                    </Text>
                    <Text style={styles.recentMeta}>{formatAccountingCents(sale.totalCents)}</Text>
                  </View>
                ))}
              </Card>
            </BentoCell>
          )}

          {expiringSoon.length > 0 && (
            <BentoCell span={6}>
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
  recentRow: { paddingVertical: 11, borderBottomWidth: 1, borderBottomColor: theme.bentoLine },
  recentName: { fontSize: 13, fontWeight: '700', color: theme.bentoInk },
  recentMeta: { fontSize: 11, marginTop: 3, color: theme.bentoMuted },
  error: { color: theme.bentoLoss, fontSize: 12, fontWeight: '700', marginBottom: 12 },
});
