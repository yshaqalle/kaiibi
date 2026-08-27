import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AccountingTabBar } from '@/components/accounting/accounting-tab-bar';
import { AuditLogView } from '@/components/accounting/ledger/audit-log-view';
import { BackfillView } from '@/components/accounting/ledger/backfill-view';
import { BalanceSheetView } from '@/components/accounting/ledger/balance-sheet-view';
import { CashFlowView } from '@/components/accounting/ledger/cash-flow-view';
import { ChartOfAccountsView } from '@/components/accounting/ledger/chart-of-accounts-view';
import { FixedAssetsView } from '@/components/accounting/ledger/fixed-assets-view';
import { ClosePeriodView } from '@/components/accounting/ledger/close-period-view';
import { IncomeStatementView } from '@/components/accounting/ledger/income-statement-view';
import { JournalEntryView } from '@/components/accounting/ledger/journal-entry-view';
import { JournalsView } from '@/components/accounting/ledger/journals-view';
import { LedgerCrumb } from '@/components/accounting/ledger/ledger-crumb';
import { LedgerHub, LEDGER_VIEWS, type LedgerView } from '@/components/accounting/ledger/ledger-hub';
import { ReportsHub, isReportView, reportViewMeta, type ReportView } from '@/components/accounting/reports/reports-hub';
import { TrialBalanceView } from '@/components/accounting/ledger/trial-balance-view';
import { BentoControlBar } from '@/components/ui/bento-control-bar';
import { Colors } from '@/constants/theme';
import { CashBudgetsTab } from '@/components/accounting/cash-budgets-tab';
import { ExpensesTab } from '@/components/accounting/expenses-tab';
import { InvoicesTab } from '@/components/accounting/invoices-tab';
import { OverviewTab } from '@/components/accounting/overview-tab';
import { PayrollTab } from '@/components/accounting/payroll-tab';
import { ReceivablesTab } from '@/components/accounting/receivables-tab';
import { ReportsTab } from '@/components/accounting/reports-tab';
import { formatRangeLabel, TransactionsTab } from '@/components/accounting/transactions-tab';
import { type DateRange, type RangePreset } from '@/components/range-selector';
import { useAuth } from '@/hooks/use-auth';
import { usePullToRefresh } from '@/hooks/use-pull-to-refresh';
import { listAccounts, listUnpostedLedgerCounts } from '@/lib/ledger';
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

type AccountingTab = 'overview' | 'transactions' | 'receivables' | 'invoices' | 'expenses' | 'payroll' | 'cash' | 'accounting' | 'reports';

// The blurb says what the tab is FOR. Seven tabs of money is a lot to hold in
// your head, and "Bills" alone does not distinguish what you owe suppliers
// from what you spend day to day.
const TAB_OPTIONS: { key: AccountingTab; label: string; blurb: string }[] = [
  { key: 'overview', label: 'Overview', blurb: 'Where the money came from and where it went.' },
  { key: 'transactions', label: 'Transactions', blurb: 'Every sale and refund, line by line.' },
  // Beside Bills on purpose: one is what the shop owes, the other what it is
  // owed, and they are the same question asked in two directions.
  { key: 'receivables', label: 'Owed to you', blurb: 'Which customers owe the shop, and since when.' },
  { key: 'invoices', label: 'Bills', blurb: 'What you owe suppliers, and when it is due.' },
  { key: 'expenses', label: 'Expenses', blurb: 'What the shop spent, by category.' },
  { key: 'payroll', label: 'Payroll', blurb: 'Pay runs and what each one cost.' },
  { key: 'cash', label: 'Cash & Budgets', blurb: 'Cash on hand, recurring bills and category limits.' },
  // Between the day-to-day tabs and Reports on purpose: the books are what the
  // tabs above feed and what the reports below read.
  { key: 'accounting', label: 'Accounting', blurb: 'The books themselves — accounts, entries and the trail behind them.' },
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
  const { tab: tabParam, view: viewParam, session: sessionParam } = useLocalSearchParams<{ tab?: string; view?: string; session?: string }>();
  const initialTab: AccountingTab = TAB_OPTIONS.some((option) => option.key === tabParam)
    ? (tabParam as AccountingTab)
    : 'overview';
  const [tab, setTabState] = useState<AccountingTab>(initialTab);
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
  // Which screen is open inside the Accounting tab or the Reports tab. A URL
  // param for exactly the reason `tab` is one -- state does not survive the
  // shell's remount at TABLET_BREAKPOINT, the URL does.
  //
  // Owned by the shell rather than by the tab, too. A tab component remounts on
  // every switch, so a `view` held inside one would drop the reader back on the
  // hub every time they came back from Reports. Unknown values resolve to the
  // hub rather than rendering nothing.
  //
  // ONE param for two hubs, not two params: `tab` already says which hub you
  // are in, so `?tab=reports&view=sales` is unambiguous. Which catalogue it is
  // read against therefore depends on the tab, and a view belonging to the
  // OTHER hub reads as 'hub' here rather than being written away -- so leaving
  // the Trial Balance for Reports and coming back returns you to it.
  const [view, setViewState] = useState<LedgerView | ReportView>(
    initialTab === 'reports'
      ? isReportView(viewParam)
        ? viewParam
        : 'hub'
      : LEDGER_VIEWS.some((v) => v.key === viewParam)
        ? (viewParam as LedgerView)
        : 'hub'
  );
  const setView = useCallback(
    (next: LedgerView | ReportView) => {
      setViewState(next);
      router.setParams({ view: next });
    },
    [router]
  );
  // Hands the reader from the Reports hub to a screen on the ACCOUNTING tab.
  // The three financial statements render there and nowhere else, and a card on
  // Reports that only said so would be a signpost to a screen one press away.
  //
  // Both params in ONE setParams call, not two: `tab` decides which catalogue
  // `view` is read against on the next mount, so a render that saw the new tab
  // and the old view would resolve the view to 'hub' and land the reader on the
  // Accounting hub instead of the statement they pressed.
  const openLedgerView = useCallback(
    (next: LedgerView) => {
      setTabState('accounting');
      setViewState(next);
      router.setParams({ tab: 'accounting', view: next });
    },
    [router]
  );
  const ledgerView: LedgerView = LEDGER_VIEWS.some((v) => v.key === view) ? (view as LedgerView) : 'hub';
  const reportView: ReportView = isReportView(view) ? view : 'hub';

  // How many accounts the shop has, for the Chart of Accounts card's footer.
  // Fetched by the SHELL rather than the hub: the hub is a list of links and
  // giving it a query would make every one of its cards wait on data only one
  // of them shows. Null until it lands, so the card falls back to its static
  // scope rather than flashing "0 accounts".
  const { shop, can } = useAuth();
  const [accountCount, setAccountCount] = useState<number | null>(null);
  useEffect(() => {
    if (!shop || tab !== 'accounting') return;
    let cancelled = false;
    listAccounts(shop.id)
      .then((rows) => {
        if (!cancelled) setAccountCount(rows.filter((a) => a.archivedAt === null).length);
      })
      // A hub card's footnote is not worth an error state. The static scope is
      // a correct thing to show when the count is unknown.
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [shop, tab]);

  // How many rows are waiting to reach the ledger, for Post History's footer.
  // Fetched here for the same reason the account count is: the hub is a list of
  // links, and giving it a query would make every card wait on data one of them
  // shows.
  //
  // Only for someone who could act on it. unposted_ledger_counts gates on
  // ledger.close exactly as backfill_shop_ledger does, so asking without it is
  // a guaranteed error — and the card is hidden from that reader anyway.
  const canCloseLedger = can('ledger.close');
  const [unpostedRows, setUnpostedRows] = useState<number | null>(null);
  useEffect(() => {
    if (!shop || tab !== 'accounting' || !canCloseLedger) return;
    let cancelled = false;
    listUnpostedLedgerCounts(shop.id)
      .then((summary) => {
        if (!cancelled) setUnpostedRows(summary.totalRows);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // `view` is a dependency so the count is re-read when the reader comes back
    // to the hub from Post History, rather than still claiming the rows it just
    // posted are waiting.
  }, [shop, tab, view, canCloseLedger]);

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

  // Inside a ledger or report screen the title row names the SCREEN, not the
  // tab -- otherwise every one of them is titled "Accounting" or "Reports" and
  // the reader has no way to tell which one they opened. Both hubs read their
  // label out of their own catalogue rather than the title row forking.
  const ledgerViewMeta = LEDGER_VIEWS.find((v) => v.key === ledgerView);
  const inLedger = tab === 'accounting' && ledgerView !== 'hub';
  const inReport = tab === 'reports' && reportView !== 'hub';
  const tabOption = TAB_OPTIONS.find((t) => t.key === tab);
  const title = inLedger ? ledgerViewMeta?.label : inReport ? reportViewMeta(reportView).label : tabOption?.label;
  const blurb = inLedger ? ledgerViewMeta?.blurb : inReport ? reportViewMeta(reportView).blurb : tabOption?.blurb;
  // What the picker is actually set to, for the hub cards that follow it. A
  // card promising "7 days" to a reader who has chosen 30 gets believed.
  const rangeLabel = dateRange ? formatRangeLabel(dateRange) : null;

  return (
    <SafeAreaView edges={['left', 'right', 'bottom']} style={styles.safeArea}>
      <ScrollView contentContainerStyle={styles.content} refreshControl={pullToRefresh}>
        <View style={styles.headerRow}>
          <View style={styles.headerTitles}>
            <Text style={styles.eyebrow}>ACCOUNTING</Text>
            {(inLedger || inReport) && <LedgerCrumb label={inReport ? 'Reports' : 'Accounting'} onBack={() => setView('hub')} />}
            <Text style={styles.title}>{title}</Text>
            <Text style={styles.blurb}>{blurb}</Text>
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
            {tab === 'receivables' && <ReceivablesTab setRefresh={setTabRefresh} />}
            {tab === 'invoices' && <InvoicesTab dateRange={dateRange} locationFilter={locationFilter} setHeaderActions={setHeaderActions} setRefresh={setTabRefresh} />}
            {tab === 'expenses' && <ExpensesTab dateRange={dateRange} locationFilter={locationFilter} setHeaderActions={setHeaderActions} setRefresh={setTabRefresh} />}
            {tab === 'payroll' && <PayrollTab dateRange={dateRange} setHeaderActions={setHeaderActions} setRefresh={setTabRefresh} />}
            {tab === 'cash' && <CashBudgetsTab dateRange={dateRange} locationFilter={locationFilter} setHeaderActions={setHeaderActions} setRefresh={setTabRefresh} focusSessionId={sessionParam ?? null} />}
            {tab === 'accounting' && ledgerView === 'hub' && <LedgerHub onOpen={setView} accountCount={accountCount} unpostedRows={unpostedRows} can={can} />}
            {tab === 'accounting' && view === 'accounts' && <ChartOfAccountsView setRefresh={setTabRefresh} onOpenView={setView} />}
            {tab === 'accounting' && view === 'trial' && <TrialBalanceView setRefresh={setTabRefresh} onOpenView={setView} />}
            {tab === 'accounting' && view === 'journals' && <JournalsView dateRange={dateRange} setRefresh={setTabRefresh} />}
            {tab === 'accounting' && view === 'audit' && <AuditLogView setRefresh={setTabRefresh} />}
            {tab === 'accounting' && view === 'entry' && <JournalEntryView onPosted={() => setView('journals')} setRefresh={setTabRefresh} />}
            {tab === 'accounting' && view === 'backfill' && <BackfillView setRefresh={setTabRefresh} onOpenView={setView} />}
            {tab === 'accounting' && view === 'income' && <IncomeStatementView dateRange={dateRange} setRefresh={setTabRefresh} />}
            {/* The balance sheet takes the range's END and ignores its start:
                it is a position read at an instant, not a window. Its hub card
                says "As of today" for that reason. */}
            {tab === 'accounting' && view === 'balance' && <BalanceSheetView dateRange={dateRange} setRefresh={setTabRefresh} />}
            {tab === 'accounting' && view === 'cashflow' && <CashFlowView dateRange={dateRange} setRefresh={setTabRefresh} />}
            {/* No `dateRange`: the register is a position read at an instant --
                a book value for the last seven days is not a thing -- so this
                screen ignores the shell's window, and its hub card says "As of
                today" for that reason. */}
            {tab === 'accounting' && view === 'assets' && <FixedAssetsView setRefresh={setTabRefresh} onOpenView={setView} />}
            {/* No `dateRange`: a period is a calendar month the ledger already
                owns, so this screen lists every one of them rather than the
                shell's window. Its hub card says "Every month" for that
                reason. */}
            {tab === 'accounting' && view === 'close' && <ClosePeriodView setRefresh={setTabRefresh} onOpenView={setView} />}
            {tab === 'reports' && reportView === 'hub' && (
              <ReportsHub onOpen={setView} onOpenLedgerView={openLedgerView} rangeLabel={rangeLabel} can={can} />
            )}
            {/* The Reports tab as it was, kept on a route of its own rather
                than deleted: it holds a working profit and loss, a sales-tax
                summary and a labour ratio, and the four dimmed cards on the hub
                cannot show any of them yet. */}
            {tab === 'reports' && reportView === 'statements' && <ReportsTab dateRange={dateRange} locationFilter={locationFilter} setHeaderActions={setHeaderActions} setRefresh={setTabRefresh} />}
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
