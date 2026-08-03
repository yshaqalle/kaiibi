import { useState } from 'react';
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

  return (
    <SafeAreaView edges={['left', 'right', 'bottom']} style={styles.safeArea}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.eyebrow}>ACCOUNTING</Text>
        <Text style={styles.title}>{TAB_OPTIONS.find((t) => t.key === tab)?.label}</Text>

        {TAB_OPTIONS.length > 1 && (
          <View style={styles.tabBar}>
            <AccountingTabBar options={TAB_OPTIONS} value={tab} onChange={setTab} />
          </View>
        )}

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
            {tab === 'transactions' && <TransactionsTab dateRange={dateRange} />}
            {tab === 'invoices' && <InvoicesTab dateRange={dateRange} />}
            {tab === 'expenses' && <ExpensesTab dateRange={dateRange} />}
            {tab === 'payroll' && <PayrollTab dateRange={dateRange} />}
            {tab === 'reports' && <ReportsTab dateRange={dateRange} />}
          </>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#FFFFFF' },
  content: { padding: 24, paddingBottom: 60 },
  eyebrow: { fontSize: 10.5, fontWeight: '800', letterSpacing: 1, color: '#999999', marginBottom: 3 },
  title: { color: '#111111', fontSize: 26, fontWeight: '800', letterSpacing: -1, marginBottom: 16 },
  tabBar: { marginBottom: 16 },
});
