import { useCallback, useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { type LedgerView } from '@/components/accounting/ledger/ledger-hub';
import { useTabRefresh, type RefreshSetter } from '@/components/accounting/use-header-actions';
import { StatTile } from '@/components/stat-tile';
import { BentoCard } from '@/components/ui/bento-card';
import { BentoCell, BentoGrid } from '@/components/ui/bento';
import { Caveat } from '@/components/ui/caveat';
import { DataTable, NameCell, ValueCell, type Column } from '@/components/ui/data-table';
import { Colors } from '@/constants/theme';
import { formatAccountingCents } from '@/lib/currency';
import { errorMessage } from '@/lib/error-message';
import { toDateColumn } from '@/lib/period';
import { useAuth } from '@/hooks/use-auth';
import { useRefreshOnFocus } from '@/hooks/use-refresh-on-focus';
import {
  closeAccountingPeriod,
  closedByLabel,
  dayLabel,
  getPeriodCloseSettings,
  isOutstandingRefusal,
  listAccountingPeriods,
  listPeriodCloseEvents,
  listPeriodExceptions,
  monthLabel,
  nextDay,
  periodOnShow,
  periodToClose,
  reopenAccountingPeriod,
  type AccountingPeriod,
  type PeriodCloseEvent,
  type PeriodCloseSettings,
  type PeriodException,
} from '@/lib/periods';

const theme = Colors.light;

// Close a Period: the door onto close_accounting_period(),
// reopen_accounting_period() and period_exceptions(), all of which have existed
// since 20261002000100 and 20261003000000 with nothing to press them.
//
// THE SCREEN DOES NO ARITHMETIC, as the three statements beside it do not.
// Every figure is a column list_accounting_periods() returned: the profit
// rolled, the date a month closes by itself, what was outstanding when it
// closed. Nothing here adds anything up.
//
// AND IT DOES NOT DECIDE WHAT IS OUTSTANDING. period_exceptions() is called,
// never re-implemented. It is the same function close_accounting_period()
// refuses with, so the list a shop is shown before it closes and the list
// recorded against the period when it does cannot disagree. Phase 2b shipped a
// door that drifted from its RPC and had to be pinned back by a check; this is
// the same problem solved by not having two of the thing.
//
// THE "ASK ME" STATE IS THE DATABASE'S REFUSAL, not a check performed here.
// Pressing Close runs an UN-FORCED close, which refuses while anything is
// outstanding and names every item in the message. The screen prints what it
// named. Closing again with p_force = true is the reader's second, deliberate
// act -- that is what "ask me, then wait for a tap" means, and it is the only
// moment at which a human can be told what they are about to close over.
//
// CONFIRMATIONS ARE STATES OF A CARD, NOT DIALOGS -- the same three reasons
// backfill-view.tsx gives: lib/confirm.ts raises a real window.confirm on web
// that a Playwright check cannot dismiss; a sheet opened from inside the
// Accounting tab is a second modal and iOS drops it, which reads as a dead
// button; and re-opening a month needs a typed reason, which no dialog here can
// collect.

/**
 * The short action word for an outstanding item, keyed on `period_exceptions`'s
 * own `kind`.
 *
 * `detail` is the sentence -- the database writes it and this screen prints it
 * verbatim, because it is the same sentence that gets recorded against the
 * period. This map only supplies the chip beside it.
 *
 * The fallback matters: `period_exceptions` ships three kinds today and the
 * migration names four more it deliberately left out until the data exists
 * behind them. A kind this map has not learned about still renders, with its
 * sentence intact.
 */
const EXCEPTION_ACTIONS: Record<string, string> = {
  draft_payroll_run: 'Post it',
  stock_count_missing: 'Count',
  register_session_open: 'Close the till',
};

function actionFor(kind: string): string {
  return EXCEPTION_ACTIONS[kind] ?? 'Check';
}

/** The status pill, in bento tokens. Locked reads differently from closed on purpose. */
function StatusPill({ status }: { status: AccountingPeriod['status'] }) {
  const label = status === 'open' ? 'Open' : status === 'closed' ? 'Closed' : 'Locked';
  return (
    <View style={[styles.pill, status === 'open' && styles.pillOpen, status === 'locked' && styles.pillLocked]}>
      <Text style={[styles.pillText, status === 'open' && styles.pillTextOpen]}>{label}</Text>
    </View>
  );
}

export function ClosePeriodView({
  setRefresh,
  onOpenView,
}: {
  setRefresh: RefreshSetter;
  onOpenView: (view: LedgerView) => void;
}) {
  const { shop, can, session } = useAuth();
  // The hub hides this card without ledger.close, but `view` is a URL parameter
  // and a role can change while a session is open -- which is exactly the
  // Critical phase 3a shipped. This is the screen's own answer, not the hub's.
  const permitted = can('ledger.close');
  const viewerId = session?.user.id ?? null;

  const [periods, setPeriods] = useState<AccountingPeriod[] | null>(null);
  const [events, setEvents] = useState<Map<string, PeriodCloseEvent>>(new Map());
  const [settings, setSettings] = useState<PeriodCloseSettings | null>(null);
  const [checklist, setChecklist] = useState<PeriodException[] | null>(null);
  // The read refusing is a first-class state. list_accounting_periods() is
  // security definer and RAISES without ledger.view, so a role holding
  // ledger.close alone -- which nothing forbids, and period_exceptions()
  // explicitly allows for -- gets a P0001 here rather than an empty list.
  // Without this the screen would sit on "Loading…" for ever.
  const [readError, setReadError] = useState<string | null>(null);

  const [busy, setBusy] = useState<'closing' | 'forcing' | 'reopening' | null>(null);
  // What the un-forced close was refused with, in the database's own words. It
  // names every outstanding item, which is more than this screen could say.
  const [refusal, setRefusal] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<string | null>(null);

  const [reopening, setReopening] = useState<AccountingPeriod | null>(null);
  const [reason, setReason] = useState('');

  const load = useCallback(async () => {
    if (!shop) return;
    // The periods first and alone: it is the call that can refuse, and the
    // others are decoration around it.
    let rows: AccountingPeriod[];
    try {
      rows = await listAccountingPeriods(shop.id);
    } catch (error) {
      setPeriods(null);
      // errorMessage and NOT `error instanceof Error`: a PostgrestError is a
      // plain object and is never an Error, so that test took the fallback
      // every time and threw away the database's sentence. See error-message.ts.
      setReadError(errorMessage(error, "Could not read this shop's accounting periods."));
      return;
    }
    setReadError(null);
    setPeriods(rows);

    // The close events carry `forced`, which is what the By column is drawn
    // from -- see closedByLabel. Failing to read them costs the attribution and
    // nothing else, so it must not take the table down with it.
    try {
      setEvents(await listPeriodCloseEvents(shop.id));
    } catch {
      setEvents(new Map());
    }
    try {
      setSettings(await getPeriodCloseSettings(shop.id));
    } catch {
      setSettings(null);
    }

    // THE CHECKLIST COMES FROM period_exceptions(), CALLED. The list row's
    // `outstanding` is the same function's output already, but this call
    // carries `kind` and `count` with it, which the array of sentences does
    // not, and both are read from the one definition either way.
    // THE SAME PERIOD THE CARD AND THE BUTTON ARE ABOUT. `rows.find(open)` over
    // a newest-first list is the newest open month, which is not the one this
    // screen offers to close -- see periodToClose.
    const open = periodOnShow(rows, toDateColumn(new Date()));
    if (!open) {
      setChecklist([]);
      return;
    }
    try {
      setChecklist(await listPeriodExceptions(shop.id, open.id));
    } catch {
      setChecklist(null);
    }
  }, [shop]);

  // The mounting fetch. use-refresh-on-focus deliberately does not fire on the
  // focus that mounts a screen, so without this the page would sit empty until
  // the reader navigated away and back.
  //
  // Reached through a resolved promise rather than by calling `load()` in the
  // effect body: `load` sets state, and a setState-ing call straight out of an
  // effect is a lint error (react-hooks/set-state-in-effect). A callback that
  // resolves later is the shape the rule is asking for -- the same shape
  // backfill-view.tsx and the shell's own account-count effect take.
  useEffect(() => {
    if (!shop) return;
    let cancelled = false;
    Promise.resolve()
      .then(() => (cancelled ? undefined : load()))
      .catch((error) => {
        // The fourth site, and the one that threw the sentence away outright
        // rather than merely failing an `instanceof` test.
        if (!cancelled) setReadError(errorMessage(error, "Could not read this shop's accounting periods."));
      });
    return () => {
      cancelled = true;
    };
  }, [shop, load]);
  useRefreshOnFocus(load);
  useTabRefresh(setRefresh, load);

  // WHICH MONTH THIS SCREEN IS ABOUT, and it is not simply "the open one".
  // `periods` is newest-first and several may be open at once -- on 'ask' every
  // past month stays open for ever, and on 'automatic' the current month and
  // the last one overlap for the whole grace window. periodToClose picks the
  // OLDEST open month that has ENDED, which is the only one
  // close_accounting_period will accept; periodOnShow falls back to the newest
  // open month so the card still describes something when there is nothing to
  // close. Both live in periods.ts, tested without a render.
  const today = toDateColumn(new Date());
  const closeable = periods ? periodToClose(periods, today) : null;
  const openPeriod = periods ? periodOnShow(periods, today) : null;

  const runClose = async (force: boolean) => {
    if (!shop || !closeable || busy) return;
    setBusy(force ? 'forcing' : 'closing');
    setFailure(null);
    setOutcome(null);
    const month = monthLabel(closeable.startsOn);
    try {
      const entry = await closeAccountingPeriod(shop.id, closeable.id, force);
      setRefusal(null);
      setOutcome(
        entry === null
          ? `${month} is closed. Nothing traded in it, so there was no closing entry to write and nothing went into 3900 Retained Earnings.`
          : `${month} is closed. Its profit is now in 3900 Retained Earnings, and the closing entry is in the journals.`
      );
    } catch (error) {
      const message = errorMessage(error, 'The database refused the close.');
      // An UN-FORCED close of a month with something outstanding is the "ask
      // me" state, not a failure -- and that is decided FROM THE ERROR, not
      // from this screen's copy of `outstanding`, which is a read old enough
      // that a concurrent close, a missing account or a period that has not
      // ended all rendered as "ask me" with a Close-anyway button that failed
      // again the same way.
      if (!force && isOutstandingRefusal(message)) {
        setRefusal(message);
      } else {
        setRefusal(null);
        setFailure(message);
      }
    } finally {
      setBusy(null);
      await load();
    }
  };

  const runReopen = async () => {
    if (!shop || !reopening || busy) return;
    // Guarded HERE and not only by the button's `disabled`. The database
    // refuses an empty reason -- "Say why this period is being re-opened." --
    // so sending one is a guaranteed round trip to a refusal, and a style prop
    // is the wrong place for the rule that stops it.
    if (reason.trim().length === 0) return;
    setBusy('reopening');
    setFailure(null);
    setOutcome(null);
    const month = monthLabel(reopening.startsOn);
    try {
      await reopenAccountingPeriod(shop.id, reopening.id, reason);
      setReopening(null);
      setReason('');
      setOutcome(
        `${month} is open again. Its closing entry was reversed rather than deleted, so both halves stay in the journals and your reason is in the Audit Log.`
      );
    } catch (error) {
      setFailure(errorMessage(error, 'The database refused the re-open.'));
    } finally {
      setBusy(null);
      await load();
    }
  };

  const columns: Column<AccountingPeriod>[] = [
    {
      key: 'period',
      header: 'Period',
      width: 132,
      render: (row) => <NameCell title={monthLabel(row.startsOn)} />,
    },
    { key: 'status', header: 'Status', width: 92, render: (row) => <StatusPill status={row.status} /> },
    {
      key: 'closed',
      header: 'Closed',
      width: 120,
      render: (row) => (
        <ValueCell
          value={
            row.closedAt
              ? dayLabel(row.closedAt)
              : row.autoCloseDueOn
                ? `auto · ${dayLabel(row.autoCloseDueOn)}`
                : '—'
          }
          tone="muted"
        />
      ),
    },
    {
      key: 'by',
      header: 'By',
      width: 96,
      render: (row) => (
        <ValueCell value={row.status === 'open' ? '—' : closedByLabel(events.get(row.id), viewerId)} tone="muted" />
      ),
    },
    {
      key: 'exceptions',
      header: 'Exceptions',
      render: (row) =>
        row.status === 'open' ? (
          <NameCell
            title={(row.outstanding?.length ?? 0) === 0 ? 'Nothing outstanding' : `${row.outstanding!.length} to check`}
            meta={row.outstanding?.[0]}
          />
        ) : (
          <NameCell
            title={row.exceptions.length === 0 ? 'None' : `Closed with ${row.exceptions.length}`}
            meta={row.exceptions[0]}
          />
        ),
    },
    {
      key: 'profit',
      header: 'Profit rolled',
      width: 116,
      numeric: true,
      // The function's own column, minus the closing entry's 3900 line. Never
      // worked out here from anything else on the row.
      render: (row) => (
        <ValueCell value={row.status === 'open' ? '—' : formatAccountingCents(row.profitRolledCents)} strong />
      ),
    },
    {
      key: 'reopen',
      header: '',
      width: 92,
      render: (row) =>
        // Only a CLOSED period. Locked is final -- reopen_accounting_period
        // refuses it -- and an open one has nothing to re-open.
        row.status === 'closed' && permitted ? (
          <Pressable
            onPress={() => {
              setReopening(row);
              setReason('');
              setFailure(null);
            }}
            role="button"
            style={styles.rowAction}
          >
            <Text style={styles.rowActionText}>Re-open</Text>
          </Pressable>
        ) : (
          <ValueCell value={row.status === 'locked' ? 'Final' : '—'} tone="muted" />
        ),
    },
  ];

  return (
    <View style={styles.wrap}>
      {/* The read refused. 'partial' rather than 'wrong': nothing here is the
          reader's to fix, and a 'wrong' with no action trains people to skip
          the whole family. The database's own words, which say more than any
          wording invented here. */}
      {readError ? (
        <BentoCard title="Close a period">
          <Caveat tone="partial">{readError}</Caveat>
        </BentoCard>
      ) : null}

      {!permitted ? (
        <BentoCard title="Close a period">
          <Caveat tone="partial">
            Closing and re-opening a month needs permission to close an accounting period, which your role does not
            carry. You can still read what has closed below. Ask an owner.
          </Caveat>
        </BentoCard>
      ) : null}

      {openPeriod ? (
        <BentoGrid>
          <BentoCell span={12}>
            <BentoCard
              title={monthLabel(openPeriod.startsOn)}
              scope={openPeriod.autoCloseDueOn ? `Closes by itself ${dayLabel(openPeriod.autoCloseDueOn)}` : 'Open'}
            >
              <View style={styles.tiles}>
                <StatTile value="Open" label="Status" hint="everything still posts" variant="bento" />
                <StatTile
                  value={openPeriod.autoCloseDueOn ? dayLabel(openPeriod.autoCloseDueOn) : 'Never'}
                  label="Auto-close on"
                  hint={
                    settings
                      ? settings.mode === 'automatic'
                        ? `${settings.graceDays} days after month end`
                        : settings.mode === 'ask'
                          ? 'set to ask you first'
                          : 'set to never close by itself'
                      : 'from your close settings'
                  }
                  variant="bento"
                />
                <StatTile
                  value={
                    checklist === null ? '—' : checklist.length === 0 ? 'Clear' : `${checklist.length} to check`
                  }
                  label="Ready"
                  hint={checklist === null ? 'could not be read' : 'only you can answer these'}
                  tone={checklist !== null && checklist.length > 0 ? 'warning' : 'default'}
                  variant="bento"
                />
              </View>
              {/* The mockup shows a fourth tile, "Profit to roll". There is no
                  such figure to show: list_accounting_periods() reports
                  profit_rolled_cents from a period's STANDING CLOSING ENTRY, and
                  an open month has none. Working it out here would be the
                  screen computing a P&L, which is the one thing these screens
                  do not do. It appears in the table below the moment the month
                  closes. */}
            </BentoCard>
          </BentoCell>

          <BentoCell span={7}>
            <BentoCard title="Month-end checklist" scope="Updates live">
              {checklist === null ? (
                <Text style={styles.quiet}>Loading…</Text>
              ) : checklist.length === 0 ? (
                <Text style={styles.quiet}>
                  Nothing is outstanding for {monthLabel(openPeriod.startsOn)}. Closing it will record that.
                </Text>
              ) : (
                <View style={styles.sheet}>
                  {checklist.map((item) => (
                    <View key={item.kind} style={styles.row}>
                      <View style={styles.rowText}>
                        {/* The DATABASE's sentence, printed verbatim. It is the
                            same sentence close_accounting_period records against
                            the period, so the screen and the ledger cannot say
                            different things. */}
                        <Text style={styles.rowName}>{item.detail}</Text>
                      </View>
                      <View style={styles.chip}>
                        <Text style={styles.chipText}>{actionFor(item.kind)}</Text>
                      </View>
                    </View>
                  ))}
                </View>
              )}

              {/* THE REFUSAL, in the database's words. 'wrong' because the close
                  did not happen and there is a cause the reader can remove --
                  either by clearing the items or by deciding to close over them,
                  which is what the action does. */}
              {refusal && closeable ? (
                <Caveat
                  tone="wrong"
                  action={{ label: `Close ${monthLabel(closeable.startsOn)} anyway`, onPress: () => runClose(true) }}
                >
                  {refusal}
                </Caveat>
              ) : null}

              {failure ? (
                <Caveat tone="wrong" action={{ label: 'Try again', onPress: () => { setFailure(null); load(); } }}>
                  {failure}
                </Caveat>
              ) : null}

              {outcome ? (
                <Caveat tone="context" action={{ label: 'See it in Journals', onPress: () => onOpenView('journals') }}>
                  {outcome}
                </Caveat>
              ) : null}

              {/* NO BUTTON WITHOUT A MONTH THAT HAS ENDED. The database refuses
                  a period whose ends_on has not passed -- closing the current
                  month redates every posting into a month that is shut, and the
                  till stops -- so offering it would be offering a button that
                  raises. Said in a sentence rather than by an absence. */}
              {permitted && closeable ? (
                <Pressable
                  onPress={() => runClose(false)}
                  disabled={busy !== null}
                  style={[styles.button, styles.buttonGo, styles.buttonWide, busy !== null && styles.buttonOff]}
                  role="button"
                >
                  <Text style={styles.buttonGoText}>
                    {busy === 'closing' || busy === 'forcing'
                      ? 'Closing…'
                      : `Close ${monthLabel(closeable.startsOn)} now`}
                  </Text>
                </Pressable>
              ) : null}
              {permitted && !closeable ? (
                <Text style={styles.footnote}>
                  {monthLabel(openPeriod.startsOn)} has not ended yet, so there is nothing final to close. It can be
                  closed from {dayLabel(nextDay(openPeriod.endsOn))} — until then the month can still take a sale.
                </Text>
              ) : null}
              {permitted && closeable && closeable.autoCloseDueOn ? (
                <Text style={styles.footnote}>
                  Or leave it — {monthLabel(closeable.startsOn)} closes by itself on{' '}
                  {dayLabel(closeable.autoCloseDueOn)}.
                </Text>
              ) : null}
            </BentoCard>
          </BentoCell>

          <BentoCell span={5}>
            <BentoCard title="Closed is not frozen">
              <View style={styles.sheet}>
                <View style={styles.row}>
                  <View style={styles.rowText}>
                    <Text style={styles.rowName}>Closed</Text>
                    <Text style={styles.rowNote}>sales, bills and payments can no longer post into the month</Text>
                  </View>
                  <View style={styles.chip}>
                    <Text style={styles.chipText}>Reversible</Text>
                  </View>
                </View>
                <View style={styles.row}>
                  <View style={styles.rowText}>
                    <Text style={styles.rowName}>…but an adjusting entry still can</Text>
                    <Text style={styles.rowNote}>a deliberate correction, from someone who may close a period</Text>
                  </View>
                  <View style={styles.chip}>
                    <Text style={styles.chipText}>Adjusting</Text>
                  </View>
                </View>
                <View style={styles.row}>
                  <View style={styles.rowText}>
                    <Text style={styles.rowName}>Locked</Text>
                    <Text style={styles.rowNote}>nothing posts, ever. Manual, and final — no re-open</Text>
                  </View>
                  <View style={styles.chip}>
                    <Text style={styles.chipText}>Final</Text>
                  </View>
                </View>
              </View>
              <Caveat tone="context">
                A close is a bookkeeping act, not something that happened in the shop — so the income statement, balance
                sheet and cash flow ignore closing entries entirely, and reading a window that spans one shows the same
                trading it always did.
              </Caveat>
            </BentoCard>
          </BentoCell>
        </BentoGrid>
      ) : null}

      {/* Out of the grid: a table is read down a column, so it takes the full
          width and manages its own gutters. DataTable already scrolls sideways
          inside the card. */}
      <BentoCard title="Closed periods" scope="Every month" bodyStyle={styles.tableBody}>
        <DataTable
          columns={columns}
          rows={periods ?? []}
          keyExtractor={(row) => row.id}
          minWidth={820}
          emptyLabel={
            readError
              ? 'The periods could not be read.'
              : periods === null
                ? 'Loading…'
                : 'No month has been opened yet. One is created the first time anything posts.'
          }
        />
      </BentoCard>

      {/* Re-opening, as a state of the page rather than a dialog: it needs a
          typed reason, which is the audit trail's only explanation of why a
          month that was shut is open again. */}
      {reopening ? (
        <BentoCard title={`Re-open ${monthLabel(reopening.startsOn)}?`}>
          <Text style={styles.confirmBody}>
            The closing entry is <Text style={styles.confirmStrong}>reversed, never deleted</Text> — both halves stay in
            the journals, so the books say the month was closed and then re-opened, which is the fact. Whatever was
            recorded against it as outstanding is cleared, because there is no longer a close for it to describe.
            {reopening.status === 'closed' && reopening.closingEntryId === null
              ? ' This month closed without trading, so there is no entry to reverse — only the status moves.'
              : ''}
          </Text>
          <Text style={styles.label}>Why are you re-opening it?</Text>
          <TextInput
            value={reason}
            onChangeText={setReason}
            placeholder="A late supplier bill for the month arrived…"
            placeholderTextColor={theme.bentoMuted2}
            style={styles.input}
            multiline
          />
          <Text style={styles.footnote}>
            The database requires this, and it is the only explanation the Audit Log ever gets.
          </Text>
          <View style={styles.buttons}>
            <Pressable
              onPress={() => {
                setReopening(null);
                setReason('');
              }}
              style={[styles.button, styles.buttonGhost]}
              role="button"
            >
              <Text style={styles.buttonGhostText}>Cancel</Text>
            </Pressable>
            <Pressable
              onPress={runReopen}
              disabled={busy !== null || reason.trim().length === 0}
              style={[
                styles.button,
                styles.buttonGo,
                (busy !== null || reason.trim().length === 0) && styles.buttonOff,
              ]}
              role="button"
            >
              <Text style={styles.buttonGoText}>
                {busy === 'reopening' ? 'Re-opening…' : `Re-open ${monthLabel(reopening.startsOn)}`}
              </Text>
            </Pressable>
          </View>
        </BentoCard>
      ) : null}

      <Caveat tone="context">
        A shop owner will not remember to close a month, and a book that is never closed lets anyone edit any month for
        ever — which is the thing closing exists to prevent. So months close by themselves after a grace period, and
        close even when the checklist is not clean: what was outstanding is recorded against the month rather than
        stopping it.
      </Caveat>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 14 },
  tiles: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  tableBody: { paddingHorizontal: 10 },
  quiet: { fontSize: 12.5, lineHeight: 20, color: theme.bentoMuted },

  sheet: { backgroundColor: theme.bentoSoft, borderRadius: 16, paddingHorizontal: 14 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: theme.bentoLine,
  },
  rowText: { flexShrink: 1 },
  rowName: { fontSize: 12.5, fontWeight: '700', color: theme.bentoInk, lineHeight: 18 },
  rowNote: { fontSize: 11.5, color: theme.bentoMuted2, marginTop: 2 },

  chip: { borderRadius: 999, paddingHorizontal: 10, paddingVertical: 5, backgroundColor: theme.bentoSurface },
  chipText: { fontSize: 11, fontWeight: '800', color: theme.bentoInk2 },

  pill: { borderRadius: 999, paddingHorizontal: 9, paddingVertical: 4, backgroundColor: theme.bentoSoft, alignSelf: 'flex-start' },
  pillOpen: { backgroundColor: theme.bentoInk },
  pillLocked: { backgroundColor: theme.bentoLine },
  pillText: { fontSize: 10.5, fontWeight: '800', color: theme.bentoInk2 },
  pillTextOpen: { color: theme.bentoSurface },

  rowAction: { borderRadius: 999, paddingHorizontal: 11, paddingVertical: 6, backgroundColor: theme.bentoSoft, alignSelf: 'flex-start' },
  rowActionText: { fontSize: 11.5, fontWeight: '800', color: theme.bentoInk2 },

  label: { fontSize: 11.5, fontWeight: '800', color: theme.bentoMuted, marginTop: 12, marginBottom: 6 },
  input: {
    backgroundColor: theme.bentoSoft,
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 13,
    color: theme.bentoInk,
    minHeight: 64,
  },

  confirmBody: { fontSize: 12.5, lineHeight: 20, color: theme.bentoMuted },
  confirmStrong: { fontWeight: '800', color: theme.bentoInk },

  buttons: { flexDirection: 'row', gap: 9, marginTop: 12 },
  button: { borderRadius: 999, paddingVertical: 13, paddingHorizontal: 18, alignItems: 'center' },
  buttonWide: { marginTop: 12 },
  buttonGo: { backgroundColor: theme.bentoInk, flex: 1 },
  buttonGoText: { color: theme.bentoSurface, fontSize: 13.5, fontWeight: '800' },
  buttonGhost: { backgroundColor: theme.bentoSoft },
  buttonGhostText: { color: theme.bentoInk2, fontSize: 13.5, fontWeight: '800' },
  buttonOff: { opacity: 0.4 },
  footnote: { fontSize: 11.5, color: theme.bentoMuted2, marginTop: 8 },
});
