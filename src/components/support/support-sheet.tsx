import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { SupportCompose } from '@/components/support/support-compose';
import { SupportThreadView } from '@/components/support/support-thread-view';
import { AppModal } from '@/components/ui/app-modal';
import { Caveat } from '@/components/ui/caveat';
import { BENTO_RADIUS, Colors } from '@/constants/theme';
import { isUnread, listMyThreads, unreadCount, type SupportThread } from '@/lib/support';
import { categoryLine, groupThreads, previewLine, shortWhen, statusChip } from '@/lib/support-list';
import { supportUnreadSnapshot, syncSupportUnread } from '@/lib/support-unread';

const theme = Colors.light;

type View_ = { name: 'compose' } | { name: 'list' } | { name: 'thread'; thread: SupportThread } | { name: 'sent'; reference: string };

// One modal, three views, switched by local state rather than by routing.
// Support is something you reach for at the moment something breaks, from
// whatever screen you were on -- a route would take you off that screen and
// lose the context that makes the report useful.
//
// The body is a separate component with a `key`, and that is the whole fix for
// the sheet flickering on open and close. Both halves of that bug were the same
// mistake -- deciding which view to show AFTER the sheet was already on screen,
// and resetting it BEFORE the sheet had faded out. The body now mounts fresh on
// each open, so its initial state is the reset, and it keeps rendering whatever
// you were looking at until the fade finishes.
export function SupportSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  // Adjusting state during render on a prop change, which is React's documented
  // pattern for exactly this. An effect cannot do it: the reset has to be in
  // place for the SAME paint the modal appears in, and an effect runs after
  // that paint -- which is the flicker.
  const [openings, setOpenings] = useState(0);
  const [wasVisible, setWasVisible] = useState(visible);
  if (visible !== wasVisible) {
    setWasVisible(visible);
    // Only on the way in. Bumping it on close too would remount the body
    // mid-fade, and the reader would watch the sheet turn back into the compose
    // form as it disappeared -- the closing half of the reported bug.
    if (visible) setOpenings((n) => n + 1);
  }

  return (
    <AppModal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      {/* A modal window does not follow the Activity's adjustResize on Android,
          and never resizes at all on iOS, so the sheet keeps its full height
          under the keyboard and the ScrollView's bottom sits behind it. On both
          phones that put Send -- the last thing in the form -- past the end of
          the scrollable range while anyone is typing, which is every moment
          they would want it. Measured on a Pixel 8 and an iPhone 16 Pro.

          `padding` on Android too, not the 'height' usually paired with it:
          this View is the dimming backdrop as well as the layout box, and
          padding is inside the background, so the dimming stays full-bleed
          either way. One value that was checked on both beats two that were
          each checked on one. */}
      <KeyboardAvoidingView style={styles.backdrop} behavior="padding">
        <SupportSheetBody key={openings} onClose={onClose} />
      </KeyboardAvoidingView>
    </AppModal>
  );
}

function SupportSheetBody({ onClose }: { onClose: () => void }) {
  // The view is settled before the first paint, from the count the ☰ badge and
  // the banner are already showing. Someone who opens this with a reply waiting
  // came to read it, not to write again -- and someone who does not is shown
  // the form immediately rather than a list that turns into one.
  const [view, setView] = useState<View_>(() =>
    supportUnreadSnapshot() > 0 ? { name: 'list' } : { name: 'compose' }
  );
  const [threads, setThreads] = useState<SupportThread[]>([]);
  // Distinguishes "no threads" from "not answered yet". Without it the list
  // prints "Nothing yet." for as long as the fetch takes, at someone whose
  // unread reply is the reason they are here.
  const [loaded, setLoaded] = useState(false);
  const [listProblem, setListProblem] = useState(false);

  // A promise chain rather than async/await, for the reason spelled out in
  // support-thread-view.tsx: react-hooks/set-state-in-effect reads a setState
  // after an `await` as a synchronous one and fails the effect below.
  const load = useCallback((): Promise<void> => {
    return listMyThreads()
      .then((next) => {
        setThreads(next);
        setListProblem(false);
        setLoaded(true);
        // The ☰ badge and the banner count exactly this list. Handing it over
        // rather than letting them refetch is what drops both the moment a
        // thread is marked read -- reading writes no message, so the realtime
        // subscription behind them has nothing to report.
        syncSupportUnread(next);
      })
      .catch(() => {
        // The list is left as it was on purpose. Emptying it would print
        // "Nothing yet." at someone whose report is the reason they opened
        // this, and "your message is gone" is the worst sentence this feature
        // has.
        setListProblem(true);
        setLoaded(true);
      });
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const unread = unreadCount(threads);
  const sections = groupThreads(threads);

  return (
    <View style={styles.sheet}>
      <View style={styles.head}>
        <View style={styles.headText}>
          <Text style={styles.title}>{view.name === 'list' ? 'Your messages' : 'Help & support'}</Text>
          {view.name === 'compose' && (
            <Text style={styles.sub}>
              Tell us what&apos;s going on. We read every message and usually reply the same working day.
            </Text>
          )}
          {view.name === 'list' && unread > 0 && <Text style={styles.sub}>{unread} waiting on you</Text>}
          {/* Without this the compose view is a dead end for anyone whose
              threads are all read: the sheet opens here, and the only other
              way into the list is the screen shown straight after a send.
              A reply you have already read would be unreachable. */}
          {view.name === 'compose' && threads.length > 0 && (
            <Pressable onPress={() => setView({ name: 'list' })} hitSlop={6} accessibilityRole="button">
              <Text style={styles.headLink}>
                Your messages{unread > 0 ? ` · ${unread} unread` : ''} →
              </Text>
            </Pressable>
          )}
        </View>
        <Pressable onPress={onClose} hitSlop={10} accessibilityRole="button" accessibilityLabel="Close">
          <Text style={styles.close}>✕</Text>
        </Pressable>
      </View>

      {/* Without this the first tap on Send is spent dismissing the
          keyboard, which reads as a dead button on a form someone has just
          finished typing into. Matches every other modal ScrollView here. */}
      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        {view.name === 'compose' && (
          <SupportCompose
            onSent={(reference) => {
              void load();
              setView({ name: 'sent', reference });
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
            <Pressable onPress={() => setView({ name: 'list' })} style={styles.doneButton} accessibilityRole="button">
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
            {/* No spinner under a failure: nothing is still loading once the
                fetch has answered with an error. */}
            {!loaded && !listProblem && <ActivityIndicator style={styles.loading} />}
            {loaded && threads.length === 0 && !listProblem && <Text style={styles.empty}>Nothing yet.</Text>}

            {sections.map((section) => (
              <View key={section.group}>
                {/* The rule runs from the label to the edge rather than sitting
                    under it: a heading with a line beneath reads as an underline
                    on the words, and the job here is to separate this group from
                    the rows above it. */}
                <View style={styles.groupRow}>
                  <Text style={styles.group}>{section.label}</Text>
                  <View style={styles.groupRule} />
                </View>
                {section.threads.map((thread, index) => (
                  <ThreadRow
                    key={thread.id}
                    thread={thread}
                    divided={index > 0}
                    onPress={() => setView({ name: 'thread', thread })}
                  />
                ))}
              </View>
            ))}

            {/* Outline, and under the list rather than over it. A solid black
                button was the strongest thing on this screen, so the obvious
                move from a list of unanswered threads was to file another one
                about the same problem -- which is how one question became
                three. Still one tap; no longer the loudest. */}
            {loaded && (
              <Pressable onPress={() => setView({ name: 'compose' })} style={styles.newButton} accessibilityRole="button">
                <Text style={styles.newButtonText}>＋ New request</Text>
              </Pressable>
            )}
          </View>
        )}

        {view.name === 'thread' && (
          <SupportThreadView
            thread={view.thread}
            onBack={() => {
              // Refetched rather than patched locally, so the row they just
              // read reflects what the server actually recorded -- if the read
              // did not land, it is still unread, and saying otherwise would
              // hide a reply behind a row that looks handled.
              void load();
              setView({ name: 'list' });
            }}
          />
        )}
      </ScrollView>
    </View>
  );
}

// Everything someone needs to decide whether to open this conversation, in the
// order they need it: is it mine to act on, what is it about, what was said
// last, when, and whose move it is. The reference comes last -- it matters on a
// phone call, not while scanning.
function ThreadRow({
  thread,
  divided,
  onPress,
}: {
  thread: SupportThread;
  divided: boolean;
  onPress: () => void;
}) {
  const unread = isUnread(thread);
  const chip = statusChip(thread);
  const preview = previewLine(thread);
  const category = categoryLine(thread);
  const when = shortWhen(thread.lastMessageAt);

  return (
    <Pressable
      onPress={onPress}
      style={[styles.row, divided && styles.rowDivided]}
      accessibilityRole="button"
      // The dot is the only thing carrying "unread" visually, and a screen
      // reader cannot see it. Read out in the order it is drawn.
      accessibilityLabel={[thread.subject, chip.label, when, thread.reference].filter(Boolean).join(', ')}
    >
      {/* Rendered whether or not it is on, so subjects line up down the column
          rather than stepping in and out by 17px per row. */}
      <View style={[styles.dot, unread && styles.dotOn]} />
      <View style={styles.rowText}>
        <View style={styles.rowTop}>
          <Text style={[styles.rowSubject, unread && styles.rowSubjectUnread]} numberOfLines={1}>
            {thread.subject}
          </Text>
          <Text style={styles.rowWhen}>{when}</Text>
        </View>
        {preview && (
          <Text style={styles.rowPreview} numberOfLines={1}>
            <Text style={styles.rowPreviewWho}>{preview.who}: </Text>
            {preview.body}
          </Text>
        )}
        <View style={styles.rowMeta}>
          <View style={[styles.chip, chip.tone === 'accent' && styles.chipAccent]}>
            <Text style={[styles.chipText, chip.tone === 'accent' && styles.chipTextAccent]}>{chip.label}</Text>
          </View>
          {category.length > 0 && (
            <View style={styles.chip}>
              <Text style={styles.chipText} numberOfLines={1}>
                {category}
              </Text>
            </View>
          )}
          <Text style={styles.rowRef}>{thread.reference}</Text>
        </View>
      </View>
    </Pressable>
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
  loading: { marginVertical: 24 },
  empty: { fontSize: 13, color: theme.bentoMuted, paddingVertical: 20 },
  group: {
    fontSize: 10.5,
    fontWeight: '800',
    letterSpacing: 1,
    textTransform: 'uppercase',
    color: theme.bentoMuted2,
    marginTop: 16,
    marginBottom: 2,
  },
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, paddingVertical: 11 },
  // Between rows of the same group only. A rule directly under a heading reads
  // as an underline on the heading rather than a separator between rows.
  rowDivided: { borderTopWidth: 1, borderTopColor: theme.bentoRule },
  dot: { width: 7, height: 7, borderRadius: 4, marginTop: 6, backgroundColor: 'transparent' },
  dotOn: { backgroundColor: theme.bentoAccentInk },
  rowText: { flex: 1, minWidth: 0 },
  rowTop: { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
  rowSubject: { flex: 1, fontSize: 13.5, fontWeight: '600', color: theme.bentoInk2 },
  rowSubjectUnread: { fontWeight: '800', color: theme.bentoInk },
  rowWhen: { fontSize: 10.5, color: theme.bentoMuted2 },
  rowPreview: { fontSize: 12, color: theme.bentoMuted, marginTop: 2 },
  rowPreviewWho: { fontWeight: '800', color: theme.bentoInk2 },
  // Wraps, because three chips and a reference do not fit across a phone once
  // an area label is long. Wrapping is a taller row; truncating is a row that
  // hides which conversation it is.
  rowMeta: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6, marginTop: 6 },
  chip: {
    backgroundColor: theme.bentoSoft,
    borderRadius: 999,
    paddingVertical: 2,
    paddingHorizontal: 8,
    maxWidth: '70%',
  },
  chipText: { fontSize: 10.5, fontWeight: '700', color: theme.bentoMuted },
  chipAccent: { backgroundColor: theme.bentoAccentWash },
  chipTextAccent: { color: theme.bentoAccentInk },
  rowRef: { fontSize: 10.5, color: theme.bentoMuted2 },
  newButton: {
    marginTop: 20,
    borderWidth: 1,
    borderColor: theme.bentoRule,
    borderRadius: 999,
    paddingVertical: 12,
    alignItems: 'center',
  },
  newButtonText: { fontSize: 13, fontWeight: '800', color: theme.bentoInk2 },
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
