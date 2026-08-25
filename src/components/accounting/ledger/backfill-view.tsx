import { useCallback, useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { type LedgerView } from '@/components/accounting/ledger/ledger-hub';
import { useTabRefresh, type RefreshSetter } from '@/components/accounting/use-header-actions';
import { StatTile } from '@/components/stat-tile';
import { BentoCard } from '@/components/ui/bento-card';
import { Caveat } from '@/components/ui/caveat';
import { Colors } from '@/constants/theme';
import { useAuth } from '@/hooks/use-auth';
import { useRefreshOnFocus } from '@/hooks/use-refresh-on-focus';
import { backfillShopLedger, listUnpostedLedgerCounts } from '@/lib/ledger';
import type { UnpostedSummary } from '@/lib/ledger-backfill';
import { fromDateColumn } from '@/lib/period';

const theme = Colors.light;

// Post History: the door onto backfill_shop_ledger, which has existed and been
// dormant since 20260908000700.
//
// The screen's real job is the state BEFORE anyone presses anything -- what is
// unposted, of what kind, and what pressing will do. The press itself is one
// RPC call returning one integer.
//
// THE CONFIRMATION IS A STATE OF THIS CARD, NOT A DIALOG. Three reasons, in
// order of what they cost: lib/confirm.ts raises a real window.confirm on web,
// which a Playwright check cannot dismiss; a sheet opened from inside the
// Accounting tab is a second modal and iOS drops it, which reads as a dead
// button; and a dialog fits one sentence where the honest explanation needs
// three. It is still a confirmation -- this writes thousands of entries and
// must not be one unguarded tap -- but the copy says plainly that it is safe to
// re-run, rather than borrowing the language of a destructive act.

type Phase = 'idle' | 'confirming' | 'running' | 'done';

/** Renders "4 March 2024" from a date column. Never `new Date(dateColumn)`. */
function formatDay(dateColumn: string): string {
  return fromDateColumn(dateColumn).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
}

export function BackfillView({
  setRefresh,
  onOpenView,
}: {
  setRefresh: RefreshSetter;
  onOpenView: (view: LedgerView) => void;
}) {
  const { shop, can } = useAuth();
  // The hub hides this card without ledger.close, but `view` is a URL
  // parameter, so the screen is reachable by typing it and cannot rely on the
  // card having been hidden.
  const permitted = can('ledger.close');
  const [summary, setSummary] = useState<UnpostedSummary | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [written, setWritten] = useState(0);
  const [failure, setFailure] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!shop || !permitted) return;
    setSummary(await listUnpostedLedgerCounts(shop.id));
  }, [shop, permitted]);

  // The mounting fetch. use-refresh-on-focus deliberately does not fire on the
  // focus that mounts the screen, so without this the card would sit empty
  // until the reader navigated away and back.
  //
  // Written as `.then` with a cancelled guard rather than `useEffect(() => {
  // reload(); })` -- the shell's own account-count effect is shaped this way
  // for the same reason: calling a setState-ing function straight from an
  // effect body is a lint error (react-hooks/set-state-in-effect), and a
  // callback that resolves later is the shape the rule is actually asking for.
  useEffect(() => {
    if (!shop || !permitted) return;
    let cancelled = false;
    listUnpostedLedgerCounts(shop.id)
      .then((next) => {
        if (!cancelled) setSummary(next);
      })
      .catch((error: unknown) => {
        if (!cancelled) setFailure(error instanceof Error ? error.message : 'Could not read what is waiting to be posted.');
      });
    return () => {
      cancelled = true;
    };
  }, [shop, permitted]);
  useRefreshOnFocus(reload);
  useTabRefresh(setRefresh, reload);

  const run = async () => {
    if (!shop || phase === 'running') return;
    setPhase('running');
    setFailure(null);
    let count: number;
    try {
      count = await backfillShopLedger(shop.id);
    } catch (error) {
      setPhase('idle');
      // "Nothing was written" is the part that matters and it is true: the
      // replay runs in one transaction, so a failure half way leaves the ledger
      // exactly as it was.
      setFailure(`Nothing was written: ${error instanceof Error ? error.message : 'the database refused the replay.'}`);
      return;
    }
    setWritten(count);
    setPhase('done');
    // Read the counts again rather than deriving them from `count`. "It says it
    // wrote 3,973" and "there are 0 left" are different claims, and the second
    // is the one a reader wants -- and it goes through the same query the empty
    // state uses, so there is one code path rather than two.
    await reload();
  };

  if (!permitted) {
    return (
      <View style={styles.wrap}>
        <BentoCard title="Not yet in the ledger" scope="Right now">
          <Caveat tone="partial">
            Posting past trading into the ledger needs permission to close an accounting period, which your role does not
            carry. Ask an owner.
          </Caveat>
        </BentoCard>
      </View>
    );
  }

  const total = summary?.totalRows ?? 0;

  return (
    <View style={styles.wrap}>
      <BentoCard title="Not yet in the ledger" scope="Right now">
        <View style={styles.tiles}>
          <StatTile
            value={summary === null ? '—' : total.toLocaleString()}
            label="Entries to write"
            hint={summary === null ? 'checking…' : total === 0 ? 'everything has posted' : 'one per source row'}
            tone={total > 0 ? 'warning' : 'default'}
            variant="bento"
          />
          {total > 0 ? (
            <StatTile value={String(summary?.kindsWithRows ?? 0)} label="Kinds" hint="of the eight replayed" variant="bento" />
          ) : null}
          {summary?.oldestOn ? (
            <StatTile value={formatDay(summary.oldestOn)} label="Oldest" hint="the entry's own date" variant="bento" />
          ) : null}
        </View>
      </BentoCard>

      <BentoCard title={total > 0 ? 'What will be posted' : 'Where it looked'}>
        <View style={styles.sheet}>
          {(summary?.lines ?? []).map((line) => (
            <View key={line.kind} style={styles.row}>
              <View style={styles.rowText}>
                <Text style={styles.rowName}>{line.label}</Text>
                {/* The note only where there is something to post. On an empty
                    screen eight explanations of what is not happening is noise
                    around the one fact that matters. */}
                {total > 0 ? <Text style={styles.rowNote}>{line.note}</Text> : null}
              </View>
              <Text style={[styles.rowCount, line.count === 0 && styles.rowCountZero]}>{line.count.toLocaleString()}</Text>
            </View>
          ))}
        </View>

        {/* `wrong` because the counts above really are unreliable until this
            clears, and it carries a real action rather than a dismissal — a
            `wrong` with nothing to do about it trains people to skip the whole
            family. */}
        {failure ? (
          <Caveat
            tone="wrong"
            action={{
              label: 'Try again',
              onPress: () => {
                setFailure(null);
                reload();
              },
            }}
          >
            {failure}
          </Caveat>
        ) : null}

        {phase === 'done' ? (
          <Caveat tone="context" action={{ label: 'See them in Journals', onPress: () => onOpenView('journals') }}>
            {written === 0
              ? 'Nothing needed posting — everything was already in the ledger.'
              : `${written.toLocaleString()} ${written === 1 ? 'entry was' : 'entries were'} written, each dated when the thing it records happened. Your Trial Balance and every ledger report now cover your whole trading history rather than only the period since posting was switched on.`}
          </Caveat>
        ) : total > 0 ? (
          <Caveat tone="context">
            Each entry is dated when the thing happened, not today — so a sale rung two years ago lands two years ago, and a
            month you have already closed is re-opened to receive it. Your Trial Balance and every report that reads the
            ledger will change.
          </Caveat>
        ) : (
          <Caveat tone="context" action={{ label: 'See the ledger in Journals', onPress: () => onOpenView('journals') }}>
            Every sale, refund, delivery, stock count, supplier payment, pay run and expense has reached the ledger. New
            ones post as they happen, so there is nothing here to press — this door is only for history.
          </Caveat>
        )}

        {/* The confirmation, in place. The count is repeated on the confirm
            button on purpose: it is the one number that would tell a reader the
            screen is looking at a different shop than they are, and this is the
            last moment anyone can notice. */}
        {phase === 'confirming' ? (
          <View style={styles.confirm}>
            <Text style={styles.confirmTitle}>{`Post ${total.toLocaleString()} ${total === 1 ? 'entry' : 'entries'}?`}</Text>
            <Text style={styles.confirmBody}>
              Every past sale, refund, delivery, stock count, supplier payment, pay run and expense that has not reached
              the ledger gets one journal entry, dated when it happened.
            </Text>
            <Text style={styles.confirmBody}>
              <Text style={styles.confirmStrong}>Nothing already in the ledger changes</Text>, and running this again later
              is safe — anything posted is skipped. It may take a minute.
            </Text>
            <View style={styles.buttons}>
              <Pressable onPress={() => setPhase('idle')} style={[styles.button, styles.buttonGhost]} role="button">
                <Text style={styles.buttonGhostText}>Cancel</Text>
              </Pressable>
              <Pressable onPress={run} style={[styles.button, styles.buttonGo]} role="button">
                <Text style={styles.buttonGoText}>{`Yes, post ${total.toLocaleString()}`}</Text>
              </Pressable>
            </View>
          </View>
        ) : (
          <>
            <Pressable
              onPress={() => setPhase('confirming')}
              disabled={total === 0 || phase === 'running' || summary === null}
              style={[styles.button, styles.buttonGo, styles.buttonWide, (total === 0 || phase === 'running' || summary === null) && styles.buttonOff]}
              role="button"
            >
              <Text style={styles.buttonGoText}>
                {phase === 'running'
                  ? 'Posting…'
                  : summary === null
                    ? 'Checking…'
                    : total === 0
                      ? 'Nothing to post'
                      : `Post ${total.toLocaleString()} ${total === 1 ? 'entry' : 'entries'}`}
              </Text>
            </Pressable>
            {total > 0 && phase !== 'running' ? (
              <Text style={styles.footnote}>Safe to run again — anything already posted is skipped.</Text>
            ) : null}
            {/* No progress bar. The RPC is one transaction returning one
                integer, so there is nothing to report progress against, and a
                bar that moves on a timer rather than on work is a lie. */}
            {phase === 'running' ? (
              <Text style={styles.footnote}>
                This runs in one transaction — if anything stops it, nothing is written and you can try again.
              </Text>
            ) : null}
          </>
        )}
      </BentoCard>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 14 },
  tiles: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
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
  rowName: { fontSize: 13, fontWeight: '700', color: theme.bentoInk },
  rowNote: { fontSize: 11.5, color: theme.bentoMuted2, marginTop: 2 },
  rowCount: { fontSize: 13, fontWeight: '800', color: theme.bentoInk },
  rowCountZero: { color: theme.bentoMuted2 },
  confirm: { marginTop: 14 },
  confirmTitle: { fontSize: 15, fontWeight: '800', color: theme.bentoInk, marginBottom: 6 },
  confirmBody: { fontSize: 12.5, lineHeight: 20, color: theme.bentoMuted, marginBottom: 6 },
  confirmStrong: { fontWeight: '800', color: theme.bentoInk },
  buttons: { flexDirection: 'row', gap: 9, marginTop: 6 },
  button: { borderRadius: 999, paddingVertical: 13, paddingHorizontal: 18, alignItems: 'center' },
  buttonWide: { marginTop: 12 },
  buttonGo: { backgroundColor: theme.bentoInk, flex: 1 },
  buttonGoText: { color: theme.bentoSurface, fontSize: 13.5, fontWeight: '800' },
  buttonGhost: { backgroundColor: theme.bentoSoft },
  buttonGhostText: { color: theme.bentoInk2, fontSize: 13.5, fontWeight: '800' },
  buttonOff: { opacity: 0.4 },
  footnote: { fontSize: 11.5, color: theme.bentoMuted2, marginTop: 8, textAlign: 'center' },
});
