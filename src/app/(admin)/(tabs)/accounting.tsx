import { useLocalSearchParams } from 'expo-router';
import { useState, type ReactNode } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AccountingTabBar } from '@/components/accounting/accounting-tab-bar';
import { LocationFilterRow } from '@/components/accounting/location-filter-row';
import { CashBudgetsTab } from '@/components/accounting/cash-budgets-tab';
import { ExpensesTab } from '@/components/accounting/expenses-tab';
import { InvoicesTab } from '@/components/accounting/invoices-tab';
import { OverviewTab } from '@/components/accounting/overview-tab';
import { PayrollTab } from '@/components/accounting/payroll-tab';
import { ReportsTab } from '@/components/accounting/reports-tab';
import { TransactionsTab } from '@/components/accounting/transactions-tab';
import { RangeSelector, type DateRange, type RangePreset } from '@/components/range-selector';
import { useAuth } from '@/hooks/use-auth';
import { hasMultipleLocations } from '@/lib/location-selection';

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
  const { locations } = useAuth();
  const showStoreFilter = hasMultipleLocations(locations);
  const [dateRange, setDateRange] = useState<DateRange | null>(null);
  // Set by a link that already knows which tab it wants -- the Dashboard's
  // overdue-bill row opens Bills rather than dropping the reader on Overview
  // to find it. Read once as the INITIAL value; the tab bar owns it after
  // that, so a stale URL cannot fight a tap.
  const { tab: tabParam } = useLocalSearchParams<{ tab?: string }>();
  const [tab, setTab] = useState<AccountingTab>(
    TAB_OPTIONS.some((option) => option.key === tabParam) ? (tabParam as AccountingTab) : 'overview'
  );
  // Published by whichever tab is showing, so its buttons share the title row
  // rather than sitting in a band of their own below the filters.
  const [headerActions, setHeaderActions] = useState<ReactNode>(null);
  // Hoisted here for the same reason the range is: four tabs each kept their
  // own copy, so switching from Bills to Reports silently reset the store and
  // the reader was quietly shown a different scope than the one they picked.
  // null is the combined business view.
  const [locationFilter, setLocationFilter] = useState<string | null>(null);

  return (
    <SafeAreaView edges={['left', 'right', 'bottom']} style={styles.safeArea}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.headerRow}>
          <View style={styles.headerTitles}>
            <Text style={styles.eyebrow}>ACCOUNTING</Text>
            <Text style={styles.title}>{TAB_OPTIONS.find((t) => t.key === tab)?.label}</Text>
            <Text style={styles.blurb}>{TAB_OPTIONS.find((t) => t.key === tab)?.blurb}</Text>
          </View>
          {headerActions ? <View style={styles.headerActions}>{headerActions}</View> : null}
        </View>

        {TAB_OPTIONS.length > 1 && (
          <View style={styles.tabBar}>
            <AccountingTabBar options={TAB_OPTIONS} value={tab} onChange={setTab} />
          </View>
        )}

        {/* Rendered by the shell, not inside the tabs: moving either control
            into a tab would remount it on every tab switch and silently reset
            the filter. Labelled because two adjacent pill rows with no names
            read as one control that has stopped making sense. */}
        <View style={styles.controls}>
          <View style={styles.controlGroup}>
            <Text style={styles.controlLabel}>RANGE</Text>
            <RangeSelector onChange={setDateRange} presets={SHARED_PRESETS} initialDays={7} />
          </View>
          {/* Renders nothing for a single-store shop, taking its label and the
              divider with it. */}
          {showStoreFilter && (
            <>
              <View style={styles.controlDivider} />
              <View style={styles.controlGroup}>
                <Text style={styles.controlLabel}>STORE</Text>
                <LocationFilterRow value={locationFilter} onChange={setLocationFilter} />
              </View>
            </>
          )}
        </View>

        {/* RangeSelector reports its initial range in an effect, so the first
            render has none yet -- tabs take a non-null range rather than each
            re-implementing the "not ready" case.

            Each tab is mounted only while selected, so switching tabs refetches
            rather than holding six tabs' worth of data (and six tabs' worth of
            queries) in memory at once. */}
        {dateRange ? (
          <>
            {tab === 'overview' && <OverviewTab dateRange={dateRange} locationFilter={locationFilter} setHeaderActions={setHeaderActions} />}
            {tab === 'transactions' && <TransactionsTab dateRange={dateRange} setHeaderActions={setHeaderActions} />}
            {tab === 'invoices' && <InvoicesTab dateRange={dateRange} locationFilter={locationFilter} setHeaderActions={setHeaderActions} />}
            {tab === 'expenses' && <ExpensesTab dateRange={dateRange} locationFilter={locationFilter} setHeaderActions={setHeaderActions} />}
            {tab === 'payroll' && <PayrollTab dateRange={dateRange} setHeaderActions={setHeaderActions} />}
            {tab === 'cash' && <CashBudgetsTab dateRange={dateRange} locationFilter={locationFilter} setHeaderActions={setHeaderActions} />}
            {tab === 'reports' && <ReportsTab dateRange={dateRange} locationFilter={locationFilter} setHeaderActions={setHeaderActions} />}
          </>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#FFFFFF' },
  content: { padding: 24, paddingBottom: 60 },
  headerRow: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, marginBottom: 16, flexWrap: 'wrap' },
  headerTitles: { flexShrink: 1 },
  headerActions: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6 },
  eyebrow: { fontSize: 10.5, fontWeight: '800', letterSpacing: 1, color: '#999999', marginBottom: 3 },
  title: { color: '#111111', fontSize: 26, fontWeight: '800', letterSpacing: -1 },
  blurb: { color: '#666666', fontSize: 13, marginTop: 3 },
  tabBar: { marginBottom: 16 },
  controls: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 14,
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#ECECEC',
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
    marginBottom: 16,
  },
  // Label beside its control, not above it: stacked, the two groups sat at
  // different heights and the bar read as two rows rather than one.
  controlGroup: { flexDirection: 'row', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
  controlLabel: { fontSize: 9.5, letterSpacing: 1.1, fontWeight: '700', color: '#999999' },
  controlDivider: { width: 1, height: 22, backgroundColor: '#ECECEC' },
});
