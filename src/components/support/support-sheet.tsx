import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { SupportCompose } from '@/components/support/support-compose';
import { syncSupportUnread } from '@/components/support/support-menu-item';
import { SupportThreadView } from '@/components/support/support-thread-view';
import { AppModal } from '@/components/ui/app-modal';
import { Caveat } from '@/components/ui/caveat';
import { BENTO_RADIUS, Colors } from '@/constants/theme';
import { isUnread, listMyThreads, unreadCount, type SupportThread } from '@/lib/support';

const theme = Colors.light;

type View_ = { name: 'compose' } | { name: 'list' } | { name: 'thread'; thread: SupportThread } | { name: 'sent'; reference: string };

// One modal, three views, switched by local state rather than by routing.
// Support is something you reach for at the moment something breaks, from
// whatever screen you were on -- a route would take you off that screen and
// lose the context that makes the report useful.
export function SupportSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const [view, setView] = useState<View_>({ name: 'compose' });
  const [threads, setThreads] = useState<SupportThread[]>([]);
  const [listProblem, setListProblem] = useState(false);

  // `threads` and the sheet's own mount survive close/open, so on reopen the
  // list is tappable immediately -- someone can navigate into a thread and
  // start typing a reply before the opening-view effect's `listMyThreads`
  // lands. Without this, that fetch resolving afterwards forces `list` or
  // `compose` under them, unmounting the reply box and the words in it, which
  // nothing else persists. Set by every user-initiated view change below,
  // checked by the effect, cleared on close so the next open starts fresh.
  const userActed = useRef(false);
  const go = (next: View_) => {
    userActed.current = true;
    setView(next);
  };

  // Returns the threads so the caller can decide something from them without
  // reading state it has just set; null means the fetch failed, which is not
  // the same answer as "you have none".
  // A promise chain rather than async/await, for the reason spelled out in
  // support-thread-view.tsx: react-hooks/set-state-in-effect reads a setState
  // after an `await` as a synchronous one and fails the effect below.
  const load = useCallback((): Promise<SupportThread[] | null> => {
    return listMyThreads()
      .then((next) => {
        setThreads(next);
        setListProblem(false);
        // The ☰ badge and the banner count exactly this list. Handing it over
        // rather than letting them refetch is what drops both the moment a
        // thread is marked read -- reading writes no message, so the realtime
        // subscription behind them has nothing to report.
        syncSupportUnread(next);
        return next;
      })
      .catch(() => {
        // The list is left as it was on purpose. Emptying it would print
        // "Nothing yet." at someone whose report is the reason they opened
        // this, and "your message is gone" is the worst sentence this feature
        // has.
        setListProblem(true);
        return null;
      });
  }, []);

  useEffect(() => {
    if (!visible) return;
    void load().then((next) => {
      // Skipped once the person has already acted: this fetch was already in
      // flight when they tapped into the list or a thread, and landing now
      // would yank them back out to `list` or `compose` regardless.
      if (userActed.current) return;
      // Opening straight into the list when something is waiting: a person who
      // opens this with an unread reply came to read it, not to write again.
      setView(next && unreadCount(next) > 0 ? { name: 'list' } : { name: 'compose' });
    });
  }, [visible, load]);

  const unread = unreadCount(threads);

  const close = () => {
    userActed.current = false;
    setView({ name: 'compose' });
    onClose();
  };

  return (
    <AppModal visible={visible} transparent animationType="fade" onRequestClose={close}>
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          <View style={styles.head}>
            <View style={styles.headText}>
              <Text style={styles.title}>
                {view.name === 'list' ? 'Your messages' : 'Help & support'}
              </Text>
              {view.name === 'compose' && (
                <Text style={styles.sub}>
                  Tell us what&apos;s going on. We read every message and usually reply the same working day.
                </Text>
              )}
              {/* Without this the compose view is a dead end for anyone whose
                  threads are all read: the sheet opens here, and the only other
                  way into the list is the screen shown straight after a send.
                  A reply you have already read would be unreachable. */}
              {view.name === 'compose' && threads.length > 0 && (
                <Pressable onPress={() => go({ name: 'list' })} hitSlop={6} accessibilityRole="button">
                  <Text style={styles.headLink}>
                    Your messages{unread > 0 ? ` · ${unread} unread` : ''} →
                  </Text>
                </Pressable>
              )}
            </View>
            <Pressable onPress={close} hitSlop={10} accessibilityRole="button" accessibilityLabel="Close">
              <Text style={styles.close}>✕</Text>
            </Pressable>
          </View>

          <ScrollView contentContainerStyle={styles.body}>
            {view.name === 'compose' && (
              <SupportCompose
                onSent={(reference) => {
                  void load();
                  go({ name: 'sent', reference });
                }}
              />
            )}

            {view.name === 'sent' && (
              <View style={styles.done}>
                <View style={styles.tick}>
                  <Text style={styles.tickText}>✓</Text>
                </View>
                <Text style={styles.doneTitle}>Sent. We&apos;ve got it.</Text>
                <Text style={styles.doneSub}>
                  We&apos;ll answer here under Your messages, usually the same working day — you&apos;ll see a
                  mark on the ☰ when we do.
                </Text>
                <Text style={styles.reference}>{view.reference}</Text>
                <Pressable onPress={() => go({ name: 'list' })} style={styles.doneButton} accessibilityRole="button">
                  <Text style={styles.doneButtonText}>Your messages</Text>
                </Pressable>
              </View>
            )}

            {view.name === 'list' && (
              <View>
                {listProblem && (
                  <Caveat tone="wrong" action={{ label: 'Try again', onPress: () => void load() }}>
                    We couldn&apos;t load your messages just now. Nothing you sent is lost.
                  </Caveat>
                )}
                {threads.length === 0 && !listProblem && <Text style={styles.empty}>Nothing yet.</Text>}
                {threads.map((thread) => {
                  const unread = isUnread(thread);
                  return (
                    <Pressable
                      key={thread.id}
                      onPress={() => go({ name: 'thread', thread })}
                      style={styles.row}
                      accessibilityRole="button"
                    >
                      <View style={styles.rowText}>
                        <Text style={styles.rowSubject} numberOfLines={1}>
                          {thread.subject}
                        </Text>
                        <Text style={styles.rowMeta}>
                          {thread.reference}
                          {thread.openedBy === 'platform' ? ' · From Kaiibi' : ''}
                        </Text>
                      </View>
                      {unread && (
                        <View style={styles.unread}>
                          <Text style={styles.unreadText}>Unread</Text>
                        </View>
                      )}
                    </Pressable>
                  );
                })}
                <Pressable onPress={() => go({ name: 'compose' })} style={styles.newButton} accessibilityRole="button">
                  <Text style={styles.newButtonText}>New request</Text>
                </Pressable>
              </View>
            )}

            {view.name === 'thread' && (
              <SupportThreadView
                thread={view.thread}
                onBack={() => {
                  // Refetched rather than patched locally, so the Unread pill on
                  // the row they just read reflects what the server actually
                  // recorded -- if the read did not land, it is still unread,
                  // and saying otherwise would hide a reply behind a row that
                  // looks handled.
                  void load();
                  go({ name: 'list' });
                }}
              />
            )}
          </ScrollView>
        </View>
      </View>
    </AppModal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)', justifyContent: 'center', padding: 16 },
  sheet: {
    backgroundColor: theme.bentoSurface,
    borderRadius: BENTO_RADIUS,
    maxHeight: '90%',
    maxWidth: 560,
    width: '100%',
    alignSelf: 'center',
    overflow: 'hidden',
  },
  head: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 12,
    padding: 20,
    paddingBottom: 14,
    borderBottomWidth: 1,
    borderBottomColor: theme.bentoLine,
  },
  headText: { flex: 1, minWidth: 0 },
  title: { fontSize: 19, fontWeight: '800', letterSpacing: -0.4, color: theme.bentoInk },
  sub: { fontSize: 12.5, color: theme.bentoMuted, marginTop: 3 },
  headLink: { fontSize: 12.5, fontWeight: '800', color: theme.bentoAccentInk, marginTop: 8 },
  close: { fontSize: 15, color: theme.bentoMuted },
  body: { padding: 20, paddingBottom: 30 },
  empty: { fontSize: 13, color: theme.bentoMuted, paddingVertical: 20 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 11,
    paddingVertical: 12,
    borderTopWidth: 1,
    borderTopColor: theme.bentoRule,
  },
  rowText: { flex: 1, minWidth: 0 },
  rowSubject: { fontSize: 13, fontWeight: '700', color: theme.bentoInk },
  rowMeta: { fontSize: 10.5, color: theme.bentoMuted2 },
  unread: { backgroundColor: theme.bentoAccentWash, borderRadius: 999, paddingVertical: 3, paddingHorizontal: 9 },
  unreadText: { fontSize: 10.5, fontWeight: '800', color: theme.bentoAccentInk },
  newButton: {
    marginTop: 18,
    backgroundColor: theme.bentoInk,
    borderRadius: 999,
    paddingVertical: 12,
    alignItems: 'center',
  },
  newButtonText: { fontSize: 13, fontWeight: '800', color: theme.bentoSurface },
  done: { alignItems: 'center', paddingVertical: 26 },
  tick: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: theme.bentoUpWash,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 14,
  },
  tickText: { fontSize: 24, fontWeight: '800', color: theme.bentoUpInk },
  doneTitle: { fontSize: 18, fontWeight: '800', letterSpacing: -0.3, color: theme.bentoInk },
  doneSub: { fontSize: 12.5, color: theme.bentoMuted, textAlign: 'center', marginTop: 6, maxWidth: 320 },
  reference: {
    marginTop: 14,
    fontSize: 13,
    fontWeight: '700',
    color: theme.bentoInk2,
    backgroundColor: theme.bentoSoft,
    borderRadius: 10,
    paddingVertical: 8,
    paddingHorizontal: 14,
  },
  doneButton: {
    marginTop: 16,
    borderWidth: 1,
    borderColor: theme.bentoRule,
    borderRadius: 999,
    paddingVertical: 10,
    paddingHorizontal: 18,
  },
  doneButtonText: { fontSize: 12.5, fontWeight: '800', color: theme.bentoInk2 },
});
