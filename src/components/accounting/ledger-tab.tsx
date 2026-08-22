import { useCallback, useEffect, useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { AuditLogView } from '@/components/accounting/audit-log-view';
import { ChartOfAccountsView } from '@/components/accounting/chart-of-accounts-view';
import { FixedAssetsView } from '@/components/accounting/fixed-assets-view';
import { JournalEntriesView } from '@/components/accounting/journal-entries-view';
import { TrialBalanceView } from '@/components/accounting/trial-balance-view';
import { formatRangeLabel } from '@/components/accounting/transactions-tab';
import { useTabRefresh, type HeaderActionsSetter, type RefreshSetter } from '@/components/accounting/use-header-actions';
import type { DateRange } from '@/components/range-selector';
import { BentoFlow } from '@/components/ui/bento';
import { TabPills } from '@/components/ui/tab-pills';
import { Colors } from '@/constants/theme';
import { useAuth } from '@/hooks/use-auth';
import { useRefreshOnFocus } from '@/hooks/use-refresh-on-focus';
import { listLedgerAccounts } from '@/lib/ledger';
import type { LedgerAccount } from '@/types/models';

// Pinned to the light palette for now — no dark-mode switching yet.
const theme = Colors.light;

// The bookkeeping half of Accounting: the chart of accounts, the general
// journal, the trial balance, the asset register and the audit log.
//
// One tab with five sub-views rather than five tabs of its own. Accounting's
// pill row already carries eight destinations, and thirteen is not a row
// anybody scans -- it is a thing you scroll sideways looking for something you
// half remember the name of. The five here belong together anyway: they are
// what a bookkeeper opens, and everything else on this screen is what a
// shopkeeper opens.
//
// The chart is fetched HERE, once, and handed down. Four of the five views
// need it, and the alternative -- each fetching its own -- means switching
// sub-views refetches the same twenty-six rows and, worse, lets two views
// disagree about the chart while an account is being renamed.

type LedgerView = 'chart' | 'journal' | 'trial' | 'assets' | 'audit';

const VIEW_OPTIONS: { key: LedgerView; label: string }[] = [
  { key: 'chart', label: 'Chart of accounts' },
  { key: 'journal', label: 'Journal' },
  { key: 'trial', label: 'Trial balance' },
  { key: 'assets', label: 'Fixed assets' },
  { key: 'audit', label: 'Audit log' },
];

function extractErrorMessage(err: unknown): string {
  if (err && typeof err === 'object' && 'message' in err && typeof (err as { message: unknown }).message === 'string') {
    return (err as { message: string }).message;
  }
  return 'Something went wrong.';
}

export function LedgerTab({
  dateRange,
  locationFilter,
  setHeaderActions,
  setRefresh,
}: {
  dateRange: DateRange;
  /** Owned by the Accounting shell so it survives a tab switch. null = every store. */
  locationFilter: string | null;
  setHeaderActions: HeaderActionsSetter;
  setRefresh: RefreshSetter;
}) {
  const { shop, can } = useAuth();
  const canManage = can('ledger.manage');
  const [view, setView] = useState<LedgerView>('chart');
  const [accounts, setAccounts] = useState<LedgerAccount[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Bumped whenever a sub-view changes something the OTHER sub-views read --
  // a posted entry moves the trial balance, an archived account changes the
  // chart. Cheaper and more honest than lifting every sub-view's data up here:
  // the views own their own fetches, and this is the one signal that says
  // "yours is now stale".
  const [revision, setRevision] = useState(0);

  const reloadAccounts = useCallback(async () => {
    if (!shop) return;
    try {
      setAccounts(await listLedgerAccounts(shop.id));
      setError(null);
    } catch (err) {
      setError(extractErrorMessage(err));
    } finally {
      setLoaded(true);
    }
  }, [shop]);

  const reload = useCallback(async () => {
    await reloadAccounts();
    setRevision((n) => n + 1);
  }, [reloadAccounts]);

  useEffect(() => {
    reloadAccounts();
  }, [reloadAccounts]);
  // Coming back to this screen on a phone, where the tab shell never unmounted
  // it, so its data is as old as the last time it was looked at.
  useRefreshOnFocus(reload);
  // Published to the shell, which owns the scroller the pull happens on.
  useTabRefresh(setRefresh, reload);

  const rangeLabel = useMemo(() => formatRangeLabel(dateRange), [dateRange]);

  // A shop whose chart never seeded -- which the trigger makes very unlikely,
  // and which the backfill covers for every shop that predates it -- would
  // otherwise land on five empty screens with nothing to say why.
  if (loaded && accounts.length === 0) {
    return (
      <BentoFlow>
        <View style={styles.emptyBlock}>
          <Text style={styles.emptyTitle}>No chart of accounts yet</Text>
          <Text style={styles.emptyBody}>
            Every shop is given one when it is created. If this one is empty, the ledger has nothing to report
            into — pull down to refresh, and tell support if it stays this way.
          </Text>
          {error ? <Text style={styles.error}>{error}</Text> : null}
        </View>
      </BentoFlow>
    );
  }

  return (
    <BentoFlow>
      <View style={styles.viewBar}>
        <TabPills options={VIEW_OPTIONS} value={view} onChange={setView} />
      </View>

      {error ? <Text style={styles.error}>{error}</Text> : null}

      {view === 'chart' && (
        <ChartOfAccountsView
          accounts={accounts}
          canManage={canManage}
          onChanged={reload}
          setHeaderActions={setHeaderActions}
        />
      )}
      {view === 'journal' && (
        <JournalEntriesView
          accounts={accounts}
          canManage={canManage}
          dateRange={dateRange}
          locationFilter={locationFilter}
          revision={revision}
          onChanged={reload}
          setHeaderActions={setHeaderActions}
        />
      )}
      {view === 'trial' && (
        <TrialBalanceView
          accounts={accounts}
          dateRange={dateRange}
          locationFilter={locationFilter}
          revision={revision}
          rangeLabel={rangeLabel}
          onOpenJournal={() => setView('journal')}
          setHeaderActions={setHeaderActions}
        />
      )}
      {view === 'assets' && (
        <FixedAssetsView
          canManage={canManage}
          locationFilter={locationFilter}
          revision={revision}
          onChanged={reload}
          setHeaderActions={setHeaderActions}
        />
      )}
      {view === 'audit' && (
        <AuditLogView dateRange={dateRange} revision={revision} setHeaderActions={setHeaderActions} />
      )}
    </BentoFlow>
  );
}

const styles = StyleSheet.create({
  viewBar: { marginBottom: 2 },
  emptyBlock: { paddingVertical: 40, paddingHorizontal: 12, alignItems: 'center', gap: 8 },
  emptyTitle: { fontSize: 15, fontWeight: '800', color: theme.bentoInk },
  emptyBody: { fontSize: 13, color: theme.bentoMuted, textAlign: 'center', maxWidth: 420, lineHeight: 19 },
  error: { color: theme.bentoLoss, fontSize: 12, fontWeight: '700' },
});
