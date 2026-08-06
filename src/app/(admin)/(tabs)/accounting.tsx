import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useState, type ReactNode } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AccountingTabBar } from '@/components/accounting/accounting-tab-bar';
import { BentoControlBar } from '@/components/ui/bento-control-bar';
import { Colors } from '@/constants/theme';
import { CashBudgetsTab } from '@/components/accounting/cash-budgets-tab';
import { ExpensesTab } from '@/components/accounting/expenses-tab';
import { InvoicesTab } from '@/components/accounting/invoices-tab';
import { OverviewTab } from '@/components/accounting/overview-tab';
import { PayrollTab } from '@/components/accounting/payroll-tab';
import { ReportsTab } from '@/components/accounting/reports-tab';
import { TransactionsTab } from '@/components/accounting/transactions-tab';
import { type DateRange, type RangePreset } from '@/components/range-selector';
import { usePullToRefresh } from '@/hooks/use-pull-to-refresh';
import type { TabRefresh } from '@/components/accounting/use-header-actions';

// Pinned to the light palette for now — no dark-mode switching yet.
const theme = Colors.light;

// The Accounting screen: one shell owning the shared date range and the tab
// switch, with each tab fetching its own data. Formerly the Sales screen --
// its body now lives in transactions-tab.tsx, unchanged apart from taking the
// range from here.
//
// Tabs land incrementally (see the phased plan); only the ones that exist are
// listed, so the bar never offers a destination that renders nothing.

type AccountingTab = 'overview' | 'transactions' | 'invoices' | 'expenses' | 'payroll' | 'cash' | 'reports';

// The blurb says what the tab is FOR. Seven tabs of money is a lot to hold in
// your head, and "Bills" alone does not distinguish what you owe suppliers
// from what you spend day to day.
const TAB_OPTIONS: { key: AccountingTab; label: string; blurb: string }[] = [
  { key: 'overview', label: 'Overview', blurb: 'Where the money came from and where it went.' },
  { key: 'transactions', label: 'Transactions', blurb: 'Every sale and refund, line by line.' },
  { key: 'invoices', label: 'Bills', blurb: 'What you owe suppliers, and when it is due.' },
  { key: 'expenses', label: 'Expenses', blurb: 'What the shop spent, by category.' },
  { key: 'payroll', label: 'Payroll', blurb: 'Pay runs and what each one cost.' },
  { key: 'cash', label: 'Cash & Budgets', blurb: 'Cash on hand, recurring bills and category limits.' },
  { key: 'reports', label: 'Reports', blurb: 'Profit and loss, tax, labour and category breakdowns.' },
];

// One range control for every tab. An earlier sketch gave Bills and
// Cash & Budgets their own longer-window pickers, but stacking a second
// selector under this one reads as a bug, so instead those tabs simply don't
// let the range drive the parts of them it shouldn't: outstanding-bill totals
// and cash balances are "right now" facts, and say so on screen.
const SHARED_PRESETS: RangePreset[] = [
  { label: 'Today', days: 1 },
  { label: '7 days', days: 7 },
  { label: '30 days', days: 30 },
];

export default function AccountingScreen() {
  const router = useRouter();
  // No `showStoreFilter` here any more: BentoControlBar makes that call
  // itself, so a single-store shop hides the pill without this screen (or the
  // Dashboard) each having to remember the rule.
  const [dateRange, setDateRange] = useState<DateRange | null>(null);
  // Set by a link that already knows which tab it wants -- the Dashboard's
  // overdue-bill row opens Bills rather than dropping the reader on Overview
  // to find it. Read once as the INITIAL value; state is authoritative while
  // mounted, so a tap never waits for the URL to catch up.
  const { tab: tabParam } = useLocalSearchParams<{ tab?: string }>();
  const [tab, setTabState] = useState<AccountingTab>(
    TAB_OPTIONS.some((option) => option.key === tabParam) ? (tabParam as AccountingTab) : 'overview'
  );
  // Mirrored back into the URL on every change, because the URL is what
  // survives a remount. The web nav shell renders two different trees either
  // side of TABLET_BREAKPOINT (admin-tabs.web.tsx), so crossing it -- resizing
  // a window, rotating a tablet -- tears this screen down and builds a new one,
  // and the initializer above then reads the tab back off the URL.
  //
  // NOT a fix for the remount itself: the range, the store filter and each
  // tab's own data still reset. That has to be fixed in the shell.
  const setTab = useCallback(
    (next: AccountingTab) => {
      setTabState(next);
      router.setParams({ tab: next });
    },
    [router]
  );
  // Published by whichever tab is showing, so its buttons share the title row
  // rather than sitting in a band of their own below the filters.
  const [headerActions, setHeaderActions] = useState<ReactNode>(null);
  // Whichever tab is showing publishes its `reload` here, so the pull gesture
  // on the scroller below refreshes that tab rather than nothing. The scroller
  // belongs to this shell; the data belongs to the tab.
  const [tabRefresh, setTabRefresh] = useState<TabRefresh | null>(null);
  const pullToRefresh = usePullToRefresh(
    useCallback(async () => {
      await tabRefresh?.();
    }, [tabRefresh])
  );
  // Hoisted here for the same reason the range is: four tabs each kept their
  // own copy, so switching from Bills to Reports silently reset the store and
  // the reader was quietly shown a different scope than the one they picked.
  // null is the combined business view.
  const [locationFilter, setLocationFilter] = useState<string | null>(null);

  return (
    <SafeAreaView edges={['left', 'right', 'bottom']} style={styles.safeArea}>
      <ScrollView contentContainerStyle={styles.content} refreshControl={pullToRefresh}>
        <View style={styles.headerRow}>
          <View style={styles.headerTitles}>
            <Text style={styles.eyebrow}>ACCOUNTING</Text>
            <Text style={styles.title}>{TAB_OPTIONS.find((t) => t.key === tab)?.label}</Text>
            <Text style={styles.blurb}>{TAB_OPTIONS.find((t) => t.key === tab)?.blurb}</Text>
          </View>
          {/* Rendered by the shell, not inside the tabs: moving either control
              into a tab would remount it on every tab switch and silently
              reset the filter.

              Now sharing BentoControlBar with the Dashboard. The two screens
              previously each assembled their own range and store controls and
              had drifted into different shapes for the same choice; the pills
              no longer need labels because a dropdown states its own value. */}
          <View style={styles.headerActions}>
            <BentoControlBar
              presets={SHARED_PRESETS}
              initialDays={7}
              onRangeChange={setDateRange}
              locationFilter={locationFilter}
              onLocationChange={setLocationFilter}
              actions={headerActions}
            />
          </View>
        </View>

        {TAB_OPTIONS.length > 1 && (
          <View style={styles.tabBar}>
            <AccountingTabBar options={TAB_OPTIONS} value={tab} onChange={setTab} />
          </View>
        )}

        {/* RangeSelector reports its initial range in an effect, so the first
            render has none yet -- tabs take a non-null range rather than each
            re-implementing the "not ready" case.

            Each tab is mounted only while selected, so switching tabs refetches
            rather than holding six tabs' worth of data (and six tabs' worth of
            queries) in memory at once. */}
        {dateRange ? (
          <>
            {tab === 'overview' && <OverviewTab dateRange={dateRange} locationFilter={locationFilter} setHeaderActions={setHeaderActions} setRefresh={setTabRefresh} />}
            {tab === 'transactions' && <TransactionsTab dateRange={dateRange} setHeaderActions={setHeaderActions} setRefresh={setTabRefresh} />}
            {tab === 'invoices' && <InvoicesTab dateRange={dateRange} locationFilter={locationFilter} setHeaderActions={setHeaderActions} setRefresh={setTabRefresh} />}
            {tab === 'expenses' && <ExpensesTab dateRange={dateRange} locationFilter={locationFilter} setHeaderActions={setHeaderActions} setRefresh={setTabRefresh} />}
            {tab === 'payroll' && <PayrollTab dateRange={dateRange} setHeaderActions={setHeaderActions} setRefresh={setTabRefresh} />}
            {tab === 'cash' && <CashBudgetsTab dateRange={dateRange} locationFilter={locationFilter} setHeaderActions={setHeaderActions} setRefresh={setTabRefresh} />}
            {tab === 'reports' && <ReportsTab dateRange={dateRange} locationFilter={locationFilter} setHeaderActions={setHeaderActions} setRefresh={setTabRefresh} />}
          </>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  // The grey page the bento cards float on, matching the Dashboard.
  safeArea: { flex: 1, backgroundColor: theme.bentoPage },
  content: { padding: 18, paddingBottom: 60 },
  headerRow: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, marginBottom: 16, flexWrap: 'wrap' },
  headerTitles: { flexShrink: 1 },
  headerActions: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6 },
  eyebrow: { fontSize: 10.5, fontWeight: '800', letterSpacing: 1, color: theme.bentoMuted, marginBottom: 3 },
  title: { color: theme.bentoInk, fontSize: 26, fontWeight: '800', letterSpacing: -1 },
  blurb: { color: theme.bentoMuted, fontSize: 13, marginTop: 3 },
  tabBar: { marginBottom: 16 },
});
