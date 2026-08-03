import { useState, type ReactNode } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AccountingTabBar } from '@/components/accounting/accounting-tab-bar';
import { ExpensesTab } from '@/components/accounting/expenses-tab';
import { InvoicesTab } from '@/components/accounting/invoices-tab';
import { OverviewTab } from '@/components/accounting/overview-tab';
import { PayrollTab } from '@/components/accounting/payroll-tab';
import { ReportsTab } from '@/components/accounting/reports-tab';
import { TransactionsTab } from '@/components/accounting/transactions-tab';
import { RangeSelector, type DateRange, type RangePreset } from '@/components/range-selector';

// The Accounting screen: one shell owning the shared date range and the tab
// switch, with each tab fetching its own data. Formerly the Sales screen --
// its body now lives in transactions-tab.tsx, unchanged apart from taking the
// range from here.
//
// Tabs land incrementally (see the phased plan); only the ones that exist are
// listed, so the bar never offers a destination that renders nothing.

type AccountingTab = 'overview' | 'transactions' | 'invoices' | 'expenses' | 'payroll' | 'reports';

const TAB_OPTIONS: { key: AccountingTab; label: string }[] = [
  { key: 'overview', label: 'Overview' },
  { key: 'transactions', label: 'Transactions' },
  { key: 'invoices', label: 'Bills' },
  { key: 'expenses', label: 'Expenses' },
  { key: 'payroll', label: 'Payroll' },
  { key: 'reports', label: 'Reports' },
];

// Shared by Overview/Transactions/Expenses/Reports. Invoices and
// Cash & Budgets get their own longer-window selectors when they land, since a
// one-day window isn't a useful lens on an unpaid bill or a budget.
const SHARED_PRESETS: RangePreset[] = [
  { label: 'Today', days: 1 },
  { label: '7 days', days: 7 },
  { label: '30 days', days: 30 },
];

export default function AccountingScreen() {
  const [dateRange, setDateRange] = useState<DateRange | null>(null);
  const [tab, setTab] = useState<AccountingTab>('overview');
  // Published by whichever tab is showing, so its buttons share the title row
  // rather than sitting in a band of their own below the filters.
  const [headerActions, setHeaderActions] = useState<ReactNode>(null);

  return (
    <SafeAreaView edges={['left', 'right', 'bottom']} style={styles.safeArea}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.headerRow}>
          <View style={styles.headerTitles}>
            <Text style={styles.eyebrow}>ACCOUNTING</Text>
            <Text style={styles.title}>{TAB_OPTIONS.find((t) => t.key === tab)?.label}</Text>
          </View>
          {headerActions ? <View style={styles.headerActions}>{headerActions}</View> : null}
        </View>

        {TAB_OPTIONS.length > 1 && (
          <View style={styles.tabBar}>
            <AccountingTabBar options={TAB_OPTIONS} value={tab} onChange={setTab} />
          </View>
        )}

        {/* Rendered by the shell, not inside the tabs: moving it into a tab
            would remount it on every tab switch and silently reset the range. */}
        <RangeSelector onChange={setDateRange} presets={SHARED_PRESETS} initialDays={7} />

        {/* RangeSelector reports its initial range in an effect, so the first
            render has none yet -- tabs take a non-null range rather than each
            re-implementing the "not ready" case.

            Each tab is mounted only while selected, so switching tabs refetches
            rather than holding six tabs' worth of data (and six tabs' worth of
            queries) in memory at once. */}
        {dateRange ? (
          <>
            {tab === 'overview' && <OverviewTab dateRange={dateRange} />}
            {tab === 'transactions' && <TransactionsTab dateRange={dateRange} setHeaderActions={setHeaderActions} />}
            {tab === 'invoices' && <InvoicesTab dateRange={dateRange} setHeaderActions={setHeaderActions} />}
            {tab === 'expenses' && <ExpensesTab dateRange={dateRange} setHeaderActions={setHeaderActions} />}
            {tab === 'payroll' && <PayrollTab dateRange={dateRange} setHeaderActions={setHeaderActions} />}
            {tab === 'reports' && <ReportsTab dateRange={dateRange} setHeaderActions={setHeaderActions} />}
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
  tabBar: { marginBottom: 16 },
});
