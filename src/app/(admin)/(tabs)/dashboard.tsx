import { useCallback, useEffect, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Card } from '@/components/card';
import { GoalMeter } from '@/components/goal-meter';
import { ProductTile } from '@/components/product-tile';
import { RangeSelector, type DateRange, type RangePreset } from '@/components/range-selector';
import { StatTile } from '@/components/stat-tile';
import { TrendChart, type TrendPoint } from '@/components/trend-chart';
import { Colors } from '@/constants/theme';
import { useAuth } from '@/hooks/use-auth';
import { formatAccountingCents } from '@/lib/currency';
import { dormantCustomers, getCustomersStatsBatch, listCustomers } from '@/lib/customers';
import { totalExpenseCents } from '@/lib/expense-reporting';
import { listExpensesInRange } from '@/lib/expenses';
import { getExpiringProducts, getLowStockProducts } from '@/lib/products';
import { getDailyTotalsCents, getMonthToDateRevenueCents } from '@/lib/sales';
import type { DailyBucket } from '@/lib/sales-reporting';
import { membersActiveToday, onLeaveMemberIds, staleOpenShifts } from '@/lib/shift-hours';
import { listStaff } from '@/lib/staff';
import { listShopTimeEntries } from '@/lib/time-entries';
import { listShopTimeOffRequests } from '@/lib/time-off';
import type { Customer, Product, StaffMember, TimeEntry, TimeOffRequest } from '@/types/models';

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

type HrSnapshot = {
  activeToday: number;
  onLeave: StaffMember[];
  staleShifts: TimeEntry[];
  pendingTimeOff: TimeOffRequest[];
};

export default function DashboardScreen() {
  const { shop, can } = useAuth();
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
  const [hr, setHr] = useState<HrSnapshot | null>(null);
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
      const [dailyRows, low, expiring] = await Promise.all([
        getDailyTotalsCents(shop.id, since, until),
        getLowStockProducts(shop.id, shop.defaultLowStockLevel),
        shop.expiryTrackingEnabled ? getExpiringProducts(shop.id, shop.expiryWarningLeadDays) : Promise.resolve([]),
      ]);
      setDaily(dailyRows);
      setLowStock(low);
      setExpiringSoon(expiring);
    });

    if (canSeeExpenses) {
      await attempt('expenses', async () => {
        setExpenseCents(totalExpenseCents(await listExpensesInRange(shop.id, since, until)));
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
  }, [shop, dateRange, canSeeExpenses, canSeeCustomers, canSeeTeam, canApproveTimeOff]);

  useEffect(() => { reload(); }, [reload]);

  // The goal is a calendar-month commitment, so it stays independent of
  // whatever range is selected above.
  useEffect(() => {
    if (!shop) return;
    getMonthToDateRevenueCents(shop.id).then(setMonthToDateCents);
  }, [shop]);

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

  const attention = buildAttentionItems({ dormant, hr, lowStock, expiringSoon });

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
          <StatTile value={formatAccountingCents(revenueCents)} label="Revenue" sparkline={daily.map((d) => d.netRevenueCents)} />
          {canSeeExpenses && <StatTile value={formatAccountingCents(expenseCents)} label="Expenses" />}
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

        {shop?.monthlyRevenueGoalCents ? (
          <>
            <Text style={[styles.sectionTitle, { color: theme.text }]}>Revenue goal this month</Text>
            <Card style={styles.chartCard}>
              <GoalMeter valueCents={monthToDateCents} goalCents={shop.monthlyRevenueGoalCents} />
            </Card>
          </>
        ) : null}

        <Text style={[styles.sectionTitle, { color: theme.text }]}>Revenue</Text>
        <Card style={styles.chartCard}>
          <TrendChart data={trendData} formatValue={formatAccountingCents} />
        </Card>

        <Text style={[styles.sectionTitle, { color: theme.text }]}>Needs attention</Text>
        {attention.length === 0 ? (
          <Text style={[styles.empty, { color: theme.textSecondary }]}>Nothing needs attention right now.</Text>
        ) : (
          <Card style={styles.list}>
            {attention.map((item, index) => (
              <View key={item.key} style={[styles.attentionRow, index > 0 && { borderTopWidth: 1, borderTopColor: theme.border }]}>
                <View style={styles.attentionMain}>
                  <Text style={[styles.attentionTitle, { color: theme.text }]}>{item.title}</Text>
                  {item.detail ? <Text style={[styles.attentionDetail, { color: theme.textSecondary }]}>{item.detail}</Text> : null}
                </View>
              </View>
            ))}
          </Card>
        )}

        {lowStock.length > 0 && (
          <>
            <Text style={[styles.sectionTitle, { color: theme.text }]}>Low stock</Text>
            <Card style={styles.list}>
              {lowStock.slice(0, 5).map((product) => <ProductTile key={product.id} product={product} />)}
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

type AttentionItem = { key: string; title: string; detail?: string };

// Ordered by actionability: things awaiting a decision first, then things that
// are merely worth knowing. A list that opens with "3 customers went quiet"
// buries the time-off request someone is waiting on.
function buildAttentionItems({
  dormant,
  hr,
  lowStock,
  expiringSoon,
}: {
  dormant: { customer: Customer; lastOrderAt: string }[];
  hr: HrSnapshot | null;
  lowStock: Product[];
  expiringSoon: Product[];
}): AttentionItem[] {
  const items: AttentionItem[] = [];

  if (hr?.pendingTimeOff.length) {
    items.push({
      key: 'time-off',
      title: `${hr.pendingTimeOff.length} time-off request${hr.pendingTimeOff.length === 1 ? '' : 's'} waiting`,
      detail: 'Approve or decline in People → Team.',
    });
  }

  if (hr?.staleShifts.length) {
    items.push({
      key: 'stale-shifts',
      title: `${hr.staleShifts.length} shift${hr.staleShifts.length === 1 ? '' : 's'} still clocked in from an earlier day`,
      // Said plainly because the knock-on is invisible otherwise: open shifts
      // are excluded from hours worked, so pay is quietly understated.
      detail: 'Those hours are not counted until they clock out — fix before running payroll.',
    });
  }

  if (lowStock.length) {
    items.push({
      key: 'low-stock',
      title: `${lowStock.length} product${lowStock.length === 1 ? '' : 's'} low on stock`,
      detail: lowStock.slice(0, 3).map((p) => p.name).join(', '),
    });
  }

  if (expiringSoon.length) {
    items.push({
      key: 'expiring',
      title: `${expiringSoon.length} product${expiringSoon.length === 1 ? '' : 's'} expiring soon`,
      detail: expiringSoon.slice(0, 3).map((p) => p.name).join(', '),
    });
  }

  if (hr?.onLeave.length) {
    items.push({
      key: 'on-leave',
      title: `${hr.onLeave.length} on leave today`,
      detail: hr.onLeave.map((m) => m.fullName ?? 'Staff member').join(', '),
    });
  }

  for (const entry of dormant.slice(0, 3)) {
    const name = [entry.customer.firstName, entry.customer.lastName].filter(Boolean).join(' ');
    items.push({
      key: `dormant-${entry.customer.id}`,
      title: name || 'Customer',
      detail: `Last order ${new Date(entry.lastOrderAt).toLocaleDateString()}`,
    });
  }

  return items;
}

const styles = StyleSheet.create({
  safeArea: { flex: 1 },
  content: { padding: 24, paddingBottom: 42 },
  title: { fontSize: 26, fontWeight: '800', letterSpacing: -1, marginBottom: 16 },
  metricRow: { flexDirection: 'row', gap: 10, marginBottom: 20, flexWrap: 'wrap' },
  sectionTitle: { fontSize: 15, fontWeight: '800', marginTop: 10, marginBottom: 12 },
  chartCard: { padding: 16, marginBottom: 8 },
  list: { overflow: 'hidden', marginBottom: 8 },
  attentionRow: { flexDirection: 'row', alignItems: 'flex-start', padding: 13, gap: 12 },
  attentionMain: { flex: 1, minWidth: 0 },
  attentionTitle: { fontSize: 13, fontWeight: '700' },
  attentionDetail: { fontSize: 11.5, marginTop: 3, lineHeight: 16 },
  empty: { fontSize: 13, marginBottom: 8 },
  error: { color: '#C0392B', fontSize: 12, fontWeight: '700', marginBottom: 12 },
});
