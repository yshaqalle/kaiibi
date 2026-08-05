import { useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AttentionList } from '@/components/attention-list';
import { Card } from '@/components/card';
import { GoalMeter } from '@/components/goal-meter';
import { ProductTile } from '@/components/product-tile';
import { RangeSelector, type DateRange, type RangePreset } from '@/components/range-selector';
import { StatTile } from '@/components/stat-tile';
import { TrendChart, type TrendPoint } from '@/components/trend-chart';
import { Colors } from '@/constants/theme';
import { useAuth } from '@/hooks/use-auth';
import { buildAttentionItems, type AttentionItem } from '@/lib/attention';
import { budgetRows, type BudgetRow } from '@/lib/cash-budget-reporting';
import { listBudgets, listRecurringBills } from '@/lib/cash-budgets';
import { formatAccountingCents, formatCompactCents } from '@/lib/currency';
import { dormantCustomers, getCustomersStatsBatch, listCustomers } from '@/lib/customers';
import { totalExpenseCents } from '@/lib/expense-reporting';
import { listExpensesInRange } from '@/lib/expenses';
import { listOpenInvoices } from '@/lib/invoices';
import { hasMultipleLocations } from '@/lib/location-selection';
import { getExpiringProducts, getLowStockProducts } from '@/lib/products';
import { getDailyTotalsCents, getMonthToDateRevenueCents, listSales } from '@/lib/sales';
import type { DailyBucket } from '@/lib/sales-reporting';
import { membersActiveToday, onLeaveMemberIds, staleOpenShifts } from '@/lib/shift-hours';
import { listStaff } from '@/lib/staff';
import { listShopTimeEntries } from '@/lib/time-entries';
import { listShopTimeOffRequests } from '@/lib/time-off';
import type { Customer, Invoice, Product, RecurringBill, Sale, StaffMember, TimeEntry, TimeOffRequest } from '@/types/models';

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

  const [dateRange, setDateRange] = useState<DateRange | null>(null);
  const [daily, setDaily] = useState<DailyBucket[]>([]);
  const [expenseCents, setExpenseCents] = useState(0);
  const [lowStock, setLowStock] = useState<Product[]>([]);
  const [expiringSoon, setExpiringSoon] = useState<Product[]>([]);
  const [monthToDateCents, setMonthToDateCents] = useState(0);
  const [dormant, setDormant] = useState<{ customer: Customer; lastOrderAt: string }[]>([]);
  const [recentSales, setRecentSales] = useState<Sale[]>([]);
  const [hr, setHr] = useState<HrSnapshot | null>(null);
  const [money, setMoney] = useState<MoneySnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

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
      const [dailyRows, low, expiring, recent] = await Promise.all([
        getDailyTotalsCents(shop.id, since, until),
        // Scoped to this device's branch: a branch that is out of an item needs
        // reordering even when the other branch is overflowing, and the
        // shop-wide rollup hides exactly that.
        getLowStockProducts(shop.id, shop.defaultLowStockLevel, activeLocation?.id ?? null),
        shop.expiryTrackingEnabled ? getExpiringProducts(shop.id, shop.expiryWarningLeadDays) : Promise.resolve([]),
        listSales(shop.id, 5),
      ]);
      setDaily(dailyRows);
      setLowStock(low);
      setExpiringSoon(expiring);
      setRecentSales(recent);
    });

    if (canSeeExpenses) {
      await attempt('expenses', async () => {
        setExpenseCents(totalExpenseCents(await listExpensesInRange(shop.id, since, until)));
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
        setMoney({ openInvoices: invoices, recurringBills: bills, budgets: budgetRows(expenses, budgets) });
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
    // activeLocation is a dependency because low stock is scoped to it --
  // switching branch must re-evaluate, not show the previous branch's alerts.
  }, [shop, dateRange, activeLocation, canSeeExpenses, canSeeCustomers, canSeeTeam, canApproveTimeOff]);

  useEffect(() => { reload(); }, [reload]);

  // The goal is a calendar-month commitment, so it stays independent of
  // whatever range is selected above.
  useEffect(() => {
    if (!shop) return;
    // Scoped to the same store the goal belongs to, so the meter compares like
    // with like.
    getMonthToDateRevenueCents(shop.id, activeLocation?.id ?? null).then(setMonthToDateCents);
  }, [shop, activeLocation]);

  const revenueCents = useMemo(() => daily.reduce((sum, d) => sum + d.netRevenueCents, 0), [daily]);
  const orderCount = useMemo(() => daily.reduce((sum, d) => sum + d.orderCount, 0), [daily]);

  const trendData: TrendPoint[] = useMemo(
    () =>
      daily.map((d) => ({
        label: new Date(d.day).toLocaleDateString(undefined, { weekday: 'short' })[0],
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

  // Where each row goes. Deliberately the module, not the tab: the params it
  // wants (`?tab=invoices`, `?filter=low`) are a separate change -- see the
  // plan's phase 8 -- and sending someone to the right screen is already far
  // better than the plain text these rows used to be.
  const openAttention = (item: AttentionItem) => {
    switch (item.area) {
      case 'money':
        router.push('/accounting');
        return;
      case 'stock':
        router.push('/inventory');
        return;
      default:
        router.push('/people');
    }
  };

  return (
    <SafeAreaView edges={['left', 'right', 'bottom']} style={[styles.safeArea, { backgroundColor: theme.surface }]}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={[styles.title, { color: theme.text }]}>Dashboard</Text>

        {error && <Text style={styles.error}>{error}</Text>}

        <RangeSelector onChange={setDateRange} presets={DASHBOARD_PRESETS} initialDays={7} />

        <View style={styles.metricRow}>
          {/* Net of sales tax and refunds — tax collected is the government's
              money, so it was never revenue. Reads lower than the old figure
              for tax-enabled shops; that's the correction, not a regression. */}
          <StatTile value={formatCompactCents(revenueCents)} label="Revenue" sparkline={daily.map((d) => d.netRevenueCents)} />
          {canSeeExpenses && <StatTile value={formatCompactCents(expenseCents)} label="Expenses" />}
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

        {activeLocation?.monthlyRevenueGoalCents ? (
          <>
            {/* Named when there is more than one store, because the goal and
                the revenue below it are BOTH that store's — an unlabelled meter
                would read as the whole business's. */}
            <Text style={[styles.sectionTitle, { color: theme.text }]}>
              {showLocationName ? `Revenue goal this month · ${activeLocation.name}` : 'Revenue goal this month'}
            </Text>
            <Card style={styles.chartCard}>
              <GoalMeter valueCents={monthToDateCents} goalCents={activeLocation.monthlyRevenueGoalCents} />
            </Card>
          </>
        ) : null}

        <Text style={[styles.sectionTitle, { color: theme.text }]}>Revenue</Text>
        <Card style={styles.chartCard}>
          <TrendChart data={trendData} formatValue={formatAccountingCents} />
        </Card>

        <Text style={[styles.sectionTitle, { color: theme.text }]}>Needs attention</Text>
        <AttentionList items={attention} onSelect={openAttention} />

        {lowStock.length > 0 && (
          <>
            <Text style={[styles.sectionTitle, { color: theme.text }]}>Low stock</Text>
            <Card style={styles.list}>
              {lowStock.slice(0, 5).map((product) => <ProductTile key={product.id} product={product} />)}
            </Card>
          </>
        )}

        {recentSales.length > 0 && (
          <>
            <Text style={[styles.sectionTitle, { color: theme.text }]}>Recent transactions</Text>
            <Card style={styles.list}>
              {recentSales.map((sale) => (
                <View key={sale.id} style={[styles.recentRow, { borderBottomColor: theme.border }]}>
                  <Text style={[styles.recentName, { color: theme.text }]} numberOfLines={1}>
                    {sale.items?.map((item) => item.productName).join(', ') || 'Sale'}
                  </Text>
                  <Text style={[styles.recentMeta, { color: theme.textSecondary }]}>
                    {formatAccountingCents(sale.totalCents)}
                  </Text>
                </View>
              ))}
            </Card>
          </>
        )}

        {expiringSoon.length > 0 && (
          <>
            <Text style={[styles.sectionTitle, { color: theme.text }]}>Expiring soon</Text>
            <Card style={styles.list}>
              {expiringSoon.slice(0, 5).map((product) => <ProductTile key={product.id} product={product} />)}
            </Card>
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1 },
  content: { padding: 24, paddingBottom: 42 },
  title: { fontSize: 26, fontWeight: '800', letterSpacing: -1, marginBottom: 16 },
  metricRow: { flexDirection: 'row', gap: 10, marginBottom: 20, flexWrap: 'wrap' },
  sectionTitle: { fontSize: 15, fontWeight: '800', marginTop: 10, marginBottom: 12 },
  chartCard: { padding: 16, marginBottom: 8 },
  list: { overflow: 'hidden', marginBottom: 8 },
  recentRow: { padding: 13, borderBottomWidth: 1 },
  recentName: { fontSize: 13, fontWeight: '700' },
  recentMeta: { fontSize: 11, marginTop: 3 },
  error: { color: '#C0392B', fontSize: 12, fontWeight: '700', marginBottom: 12 },
});
