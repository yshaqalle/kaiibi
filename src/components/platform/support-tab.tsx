import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { Chip, PlatformButton, PlatformModal, SectionLabel } from '@/components/platform/kit';
import { coverEnd, fmtDate } from '@/components/platform/labels';
import { BentoCard } from '@/components/ui/bento-card';
import { Caveat } from '@/components/ui/caveat';
import { SubscriptionStatusPill } from '@/components/ui/subscription-status';
import { Colors } from '@/constants/theme';
import { openExternalUrl } from '@/lib/external-url';
import {
  callPlatformAdmin,
  supportQueueState,
  type PlatformShopRow,
  type PlatformSupportThread,
} from '@/lib/platform';
import { listMessages, whatsAppLink, type SupportMessage } from '@/lib/support';
import { signedUrlFor } from '@/lib/support-attachments';
import {
  OPERATOR_CATEGORIES,
  SUPPORT_CATEGORIES,
  categoryMeta,
  isSupportCategory,
} from '@/lib/support-taxonomy';

// Pinned to the light palette for now — no dark-mode switching yet.
const theme = Colors.light;

// The operator's queue.
//
// Every state below names WHOSE MOVE IT IS, and so does the order of the list.
// One person answers all of this, and a list sorted by age puts a thread we
// answered ten minutes ago above one nobody has touched — which is how a queue
// stops being a to-do list and becomes a history. Sorted by whose move it is,
// the top of the list is always the next thing to do.
const STATE_LABEL: Record<ReturnType<typeof supportQueueState>, string> = {
  needs_reply: 'Needs a reply',
  waiting_on_them: 'Waiting on them',
  unread_by_them: 'Unread by them',
  closed: 'Closed',
};

// 'unread_by_them' outranks 'waiting_on_them' because an outbound message
// nobody has opened is a message that never happened — it is still our problem,
// where a message they have read genuinely is theirs.
const STATE_ORDER: Record<ReturnType<typeof supportQueueState>, number> = {
  needs_reply: 0,
  unread_by_them: 1,
  waiting_on_them: 2,
  closed: 3,
};

const DAY_MS = 24 * 60 * 60 * 1000;

export function SupportTab({
  threads,
  shops,
  now,
  truncated,
  compact,
  onDone,
  onCompose,
}: {
  threads: PlatformSupportThread[];
  shops: PlatformShopRow[];
  /**
   * When the rows on screen were fetched. Passed in rather than read here so
   * the "past a day" count and the caveat that explains it are measured
   * against one instant, and so nothing reads the clock during render.
   */
  now: number;
  /**
   * True when listSupportThreads' 200-row cap came back full. A queue that
   * quietly dropped its oldest rows reads as a short queue unless something
   * says otherwise, and a silently truncated one is worse than a slow one.
   */
  truncated: boolean;
  /** Below TABLET_BREAKPOINT, where the reply panel stacks instead of splitting. */
  compact: boolean;
  /** Reloads the console. Awaited after every write so the queue re-ranks. */
  onDone: () => Promise<void>;
  onCompose: () => void;
}) {
  const [filter, setFilter] = useState<string | null>(null);
  // The ID, not the row. `threads` is replaced wholesale by every reload, and a
  // panel holding the object it was opened with would keep showing the state
  // the thread was in before the operator answered it.
  const [openedId, setOpenedId] = useState<string | null>(null);

  const open = threads.filter((t) => t.status === 'open');
  const stale = open.filter(
    (t) => supportQueueState(t) === 'needs_reply' && now - Date.parse(t.lastMessageAt) > DAY_MS
  );
  const billing = open.filter((t) => t.category === 'billing');

  const shown = useMemo(() => {
    const matching = filter ? threads.filter((t) => t.category === filter) : threads;
    // listSupportThreads already returns newest first, and sort() is stable, so
    // ranking by state alone leaves recency as the tie-break inside each group.
    return [...matching].sort(
      (a, b) => STATE_ORDER[supportQueueState(a)] - STATE_ORDER[supportQueueState(b)]
    );
  }, [threads, filter]);

  // The thread carries the store's name but not its tier — that lives on the
  // shops list the console has already loaded, so it is joined here rather than
  // bought with a second subscription join per conversation.
  const planOf = (shopId: string) => shops.find((s) => s.shopId === shopId)?.planName ?? '—';

  // Falls back to null rather than staying open on a stale copy: a reload that
  // no longer carries this thread (the 200-row cap moved past it) has nothing
  // truthful left to render in the panel.
  const opened = threads.find((t) => t.id === openedId) ?? null;

  return (
    // The 14 is BentoGrid's own gap (src/components/ui/bento.tsx). Two cards
    // stacked outside a grid get no spacing from `Card` itself, so they would
    // otherwise sit flush and read as one.
    <View style={styles.stack}>
      <BentoCard title="Support">
        <View style={styles.kpis}>
          <Kpi value={String(open.length)} label="Open" hint={`${stale.length} unanswered > 24h`} />
          <Kpi value={String(billing.length)} label="Billing" hint="money waiting on us" />
          <Kpi value={String(threads.length)} label="All time" hint="conversations" />
        </View>
      </BentoCard>

      <BentoCard
        title="Conversations"
        actions={
          <Pressable onPress={onCompose} style={styles.newButton}>
            <Text style={styles.newButtonText}>✉ New message</Text>
          </Pressable>
        }
      >
        <View style={styles.filters}>
          <Chip label={`All ${threads.length}`} active={filter === null} onPress={() => setFilter(null)} />
          {SUPPORT_CATEGORIES.map((category) => (
            <Chip
              key={category.key}
              label={`${category.shortLabel} ${threads.filter((t) => t.category === category.key).length}`}
              active={filter === category.key}
              onPress={() => setFilter(category.key)}
            />
          ))}
        </View>

        {shown.length === 0 ? (
          <Text style={styles.empty}>Nothing here.</Text>
        ) : (
          shown.map((thread) => {
            const state = supportQueueState(thread);
            return (
              <Pressable key={thread.id} onPress={() => setOpenedId(thread.id)} style={styles.row}>
                <View style={styles.rowText}>
                  <Text style={styles.subject} numberOfLines={1}>
                    {thread.subject}
                    {thread.openedBy === 'platform' ? '  (we started this)' : ''}
                  </Text>
                  <Text style={styles.meta} numberOfLines={1}>
                    {[
                      thread.reference,
                      thread.shopName,
                      planOf(thread.shopId),
                      thread.authorName,
                      thread.attachmentCount ? `${thread.attachmentCount} attachments` : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </Text>
                </View>
                {thread.contactPreference === 'whatsapp' && (
                  <View style={styles.waChip}>
                    <Text style={styles.waChipText}>Wants WhatsApp</Text>
                  </View>
                )}
                <View style={[styles.stateChip, state === 'needs_reply' && styles.stateUrgent]}>
                  <Text style={[styles.stateText, state === 'needs_reply' && styles.stateTextUrgent]}>
                    {STATE_LABEL[state]}
                  </Text>
                </View>
              </Pressable>
            );
          })
        )}

        {stale.length > 0 && (
          <Caveat tone="partial">
            {`${stale.length} ${stale.length === 1 ? 'conversation is' : 'conversations are'} past a day with no reply. A store waiting on a payment match is a store deciding whether to keep paying.`}
          </Caveat>
        )}

        {truncated && (
          <Caveat tone="partial">
            {'Showing the 200 most recently active conversations. Older, untouched threads are not in this list.'}
          </Caveat>
        )}
      </BentoCard>

      {opened && (
        <PlatformModal title={opened.subject} compact={compact} onClose={() => setOpenedId(null)}>
          <SupportThreadPanel
            // Remounts when the operator opens a different conversation, so the
            // message list and the half-typed reply never survive into a thread
            // they were not written for.
            key={opened.id}
            thread={opened}
            shop={shops.find((s) => s.shopId === opened.shopId)}
            wide={!compact}
            onDone={onDone}
            onClose={() => setOpenedId(null)}
          />
        </PlatformModal>
      )}
    </View>
  );
}

function Kpi({ value, label, hint }: { value: string; label: string; hint: string }) {
  return (
    <View>
      <Text style={styles.kpiValue}>{value}</Text>
      <Text style={styles.kpiLabel}>{label}</Text>
      <Text style={styles.kpiHint}>{hint}</Text>
    </View>
  );
}

type SendOptions = { close?: boolean; whatsApp?: boolean };

// Which thing to retry travels with the message, the way the store's thread
// view does it, because five different things fail here and a 'wrong' caveat
// owes the reader the fix for the one that actually broke.
//
// 'close' carries its own reason rather than re-reading the draft: by the time
// a close can fail the reply is already on the server and the box has been
// emptied, and platform-admin refuses an action with no reason.
type Retry =
  | { kind: 'load' }
  | { kind: 'send'; opts: SendOptions }
  | { kind: 'close'; reason: string }
  | { kind: 'handOff'; text: string }
  | { kind: 'attachment'; path: string };

type Problem = { message: string; retry: Retry };

/**
 * One conversation, answered here rather than on WhatsApp.
 *
 * The rail on the right is the entire argument for that. Half of what an
 * operator would otherwise go hunting for — whether this store is paid up, who
 * is asking, what they were holding when it broke — is already on the screen
 * they are typing into, so the reply gets written against the facts instead of
 * against a guess.
 */
function SupportThreadPanel({
  thread,
  shop,
  wide,
  onDone,
  onClose,
}: {
  thread: PlatformSupportThread;
  /**
   * Undefined when the store is not in the list the console loaded — a shop
   * deleted since. The money rows read "—" rather than guessing at a tier.
   */
  shop: PlatformShopRow | undefined;
  wide: boolean;
  onDone: () => Promise<void>;
  onClose: () => void;
}) {
  const [messages, setMessages] = useState<SupportMessage[] | null>(null);
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  // `busy` alone is not a guard: two presses landing before the state has
  // re-rendered the buttons both see them enabled, and reply_support is an
  // insert with nothing on the server to collapse the second into the first.
  // Checked and set synchronously, before either await starts.
  const sendInFlight = useRef(false);

  // A promise chain rather than async/await: react-hooks/set-state-in-effect
  // reads a setState after an `await` as a synchronous one and fails the effect
  // that calls this, while the same setState inside a `.then` is what the rule
  // asks for.
  const load = useCallback((): Promise<void> => {
    // Clears no problem on success. This also runs after a send, and a close
    // or a hand-off that failed AFTER the reply landed has already put its own
    // caveat up -- one that reloading the messages does nothing to resolve.
    // Whatever raised a problem is what clears it, in retryProblem or in send.
    return listMessages(thread.id)
      .then(setMessages)
      .catch((error: unknown) => {
        setProblem({
          message: error instanceof Error ? error.message : 'Could not load this conversation.',
          retry: { kind: 'load' },
        });
      });
  }, [thread.id]);

  useEffect(() => {
    void load();
  }, [load]);

  // Separated from `send` so its failure can never be retried as a reply: by
  // the time this runs the message is written, and a "Try again" that re-ran
  // the whole send would post it a second time.
  const closeThread = async (reason: string): Promise<boolean> => {
    try {
      await callPlatformAdmin('close_support', { support: { threadId: thread.id } }, reason);
      return true;
    } catch (error) {
      setProblem({
        message: error instanceof Error ? error.message : 'The reply sent, but the conversation stayed open.',
        retry: { kind: 'close', reason },
      });
      return false;
    }
  };

  // Opened AFTER the reply is written, never instead of it. Kaiibi does not
  // send the WhatsApp message — it hands the operator a chat with this reply
  // already in the box — so a hand-off that never opens costs a paste and
  // nothing else, because the thread already has the record.
  //
  // Guarded separately for that same reason: a throw here reported as a failed
  // send would be a lie about the one thing this ordering exists to protect.
  const handOff = (text: string): void => {
    const link = whatsAppLink(thread.authorPhone, text);
    if (!link) return;
    try {
      openExternalUrl(link);
    } catch {
      setProblem({
        message: 'The reply is on the thread, but WhatsApp did not open.',
        retry: { kind: 'handOff', text },
      });
    }
  };

  const send = async (opts: SendOptions): Promise<void> => {
    const body = reply.trim();
    if (!body) {
      setProblem({ message: 'Write something first.', retry: { kind: 'send', opts } });
      return;
    }
    if (sendInFlight.current) return;
    sendInFlight.current = true;
    setBusy(true);
    setProblem(null);
    try {
      // The body is passed as `reason`. platform-admin requires one on every
      // action, and for support the body IS the justification — see the comment
      // on the case in that function — so the audit log records what was
      // actually said rather than a second sentence about it.
      await callPlatformAdmin('reply_support', { support: { threadId: thread.id } }, body);
      // Emptied the moment the reply is on the server, and before anything that
      // can still fail below it: a draft left in the box is a draft somebody
      // presses Send on twice.
      setReply('');

      const closed = opts.close === true && (await closeThread(body));
      if (opts.whatsApp) handOff(body);

      await load();
      await onDone();
      // Only a closed conversation leaves the queue, so only a close earns the
      // panel shutting -- and only one that actually landed, or the panel would
      // dismiss itself over the caveat explaining why it did not.
      if (closed) onClose();
    } catch (error) {
      setProblem({
        message: error instanceof Error ? error.message : 'That reply did not go through.',
        retry: { kind: 'send', opts },
      });
    } finally {
      sendInFlight.current = false;
      setBusy(false);
    }
  };

  const openAttachment = async (path: string): Promise<void> => {
    try {
      // The bucket is private, so this needs a signed URL. Handed to the
      // wrapper rather than Linking.openURL: on web a blocked window.open
      // sometimes reuses the CURRENT tab, which here would navigate the console
      // away and take the half-written reply with it.
      openExternalUrl(await signedUrlFor(path));
    } catch {
      setProblem({ message: 'Could not open that file.', retry: { kind: 'attachment', path } });
    }
  };

  const openChat = (): void => {
    const link = whatsAppLink(thread.authorPhone);
    if (link) openExternalUrl(link);
  };

  const retryProblem = (): void => {
    if (!problem) return;
    // Cleared first so the retry is visible: a "Try again" that leaves the
    // caveat sitting there looks like it did nothing.
    const { retry } = problem;
    setProblem(null);
    if (retry.kind === 'load') void load();
    else if (retry.kind === 'send') void send(retry.opts);
    else if (retry.kind === 'close') void closeThread(retry.reason);
    else if (retry.kind === 'handOff') handOff(retry.text);
    else void openAttachment(retry.path);
  };

  // Asked of the link rather than of the phone field, as whatsapp.ts asks
  // callers to: a number that cannot be dialled produces no link, and offering
  // to message someone we cannot reach is worse than not offering.
  const chatLink = whatsAppLink(thread.authorPhone);
  const cover = shop ? coverEnd(shop) : null;

  return (
    <View style={[panelStyles.wrap, wide && panelStyles.wrapWide]}>
      <View style={[panelStyles.main, wide && panelStyles.mainWide]}>
        <Text style={panelStyles.threadMeta}>
          {[
            thread.reference,
            categoryLabel(thread.category),
            areaLabel(thread),
            thread.status === 'open' ? 'Open' : 'Closed',
            `last message ${fmtDate(thread.lastMessageAt)}`,
          ]
            .filter(Boolean)
            .join(' · ')}
        </Text>

        {messages === null ? (
          // No spinner under a failure: nothing is still loading once the load
          // has answered with an error, and a spinner that never stops reads as
          // a frozen screen rather than a failed one.
          problem === null && <ActivityIndicator style={panelStyles.loading} />
        ) : (
          messages.map((message) => (
            <View
              key={message.id}
              style={[
                panelStyles.bubble,
                message.authorKind === 'platform' ? panelStyles.fromUs : panelStyles.fromShop,
              ]}
            >
              <Text style={[panelStyles.author, message.authorKind === 'platform' && panelStyles.authorUs]}>
                {message.authorKind === 'platform' ? 'Kaiibi support' : personLabel(thread)}
              </Text>
              <Text style={[panelStyles.body, message.authorKind === 'platform' && panelStyles.bodyUs]}>
                {message.body}
              </Text>
              {message.attachments.map((attachment) => (
                <Pressable
                  key={attachment.id}
                  onPress={() => openAttachment(attachment.storagePath)}
                  accessibilityRole="link"
                >
                  <Text style={panelStyles.attachment}>📎 {attachment.fileName}</Text>
                </Pressable>
              ))}
            </View>
          ))
        )}

        <SectionLabel>Your reply</SectionLabel>
        <TextInput
          value={reply}
          onChangeText={setReply}
          placeholder="Write back…"
          placeholderTextColor={theme.bentoMuted2}
          multiline
          style={panelStyles.input}
        />

        <View style={panelStyles.actions}>
          <PlatformButton label={busy ? 'Sending…' : 'Send reply'} disabled={busy} onPress={() => void send({})} />
          {thread.contactPreference === 'whatsapp' && chatLink && (
            <PlatformButton
              label="Send & open WhatsApp"
              quiet
              disabled={busy}
              onPress={() => void send({ whatsApp: true })}
            />
          )}
          <PlatformButton label="Send & close" quiet disabled={busy} onPress={() => void send({ close: true })} />
        </View>

        {thread.contactPreference === 'whatsapp' && (
          <Caveat tone="context">
            {
              'They asked to be nudged on WhatsApp too. Send writes the reply into the thread as always; Send & open WhatsApp does that and then opens their chat with this reply already in the box. Kaiibi never sends the WhatsApp message itself — you do, from your own account.'
            }
          </Caveat>
        )}
        {problem && (
          <Caveat tone="wrong" action={{ label: 'Try again', onPress: retryProblem }}>
            {problem.message}
          </Caveat>
        )}
      </View>

      <View style={[panelStyles.rail, wide && panelStyles.railWide]}>
        <Rail title="Who this is">
          <RailRow k="Store" v={thread.shopName} />
          <RailRow k="Person" v={personLabel(thread)} />
          {thread.authorPhone && (
            <RailRow
              k="WhatsApp"
              v={thread.authorPhone}
              action={chatLink ? { label: 'Open chat', onPress: openChat } : undefined}
            />
          )}
        </Rail>

        <Rail title="Money">
          <RailRow k="Plan" v={shop?.planName ?? '—'} />
          <RailRow k="Status" v={shop ? <SubscriptionStatusPill status={shop.status} /> : '—'} />
          {cover && <RailRow k={cover.label === 'renews' ? 'Renews' : 'Trial ends'} v={fmtDate(cover.ends)} />}
          {shop?.manualStatus === 'suspended' && <RailRow k="Access" v="Suspended by us" />}
        </Rail>

        <Rail title="Sent from">
          {Object.keys(thread.clientContext).length === 0 ? (
            // Threads we opened carry no device context at all, and neither do
            // ones filed before this shipped. Saying so beats an empty card the
            // operator reads as a failed load.
            <RailRow k="Nothing recorded" v="—" />
          ) : (
            Object.entries(thread.clientContext).map(([key, value]) => (
              <RailRow key={key} k={CONTEXT_LABELS[key] ?? key} v={String(value)} />
            ))
          )}
        </Rail>
      </View>
    </View>
  );
}

function Rail({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View style={panelStyles.railCard}>
      <Text style={panelStyles.railTitle}>{title.toUpperCase()}</Text>
      {children}
    </View>
  );
}

function RailRow({
  k,
  v,
  action,
}: {
  k: string;
  v: string | ReactNode;
  action?: { label: string; onPress: () => void };
}) {
  return (
    <View style={panelStyles.railRow}>
      <Text style={panelStyles.railKey}>{k}</Text>
      <View style={panelStyles.railValueWrap}>
        {typeof v === 'string' ? <Text style={panelStyles.railValue}>{v}</Text> : v}
        {action && (
          <Pressable onPress={action.onPress} accessibilityRole="link" style={panelStyles.railAction}>
            <Text style={panelStyles.railActionText}>{action.label}</Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}

// buildClientContext writes camelCase keys, and the map is open-ended by
// design — an unknown key is shown as it arrived rather than dropped, because
// the reason it is there is that somebody added it to help answer a question
// like this one.
const CONTEXT_LABELS: Record<string, string> = {
  platform: 'Platform',
  deviceClass: 'Device',
  screen: 'Screen',
  appVersion: 'App version',
  buildNumber: 'Build',
  locationName: 'Branch',
};

// `authorUserId` is what separates the two nulls. A thread we started has no
// author at all; a thread they started whose name we could not read is a
// profile we failed to resolve, and telling the operator "we started this" in
// that case would be a lie about who is waiting.
function personLabel(thread: PlatformSupportThread): string {
  if (thread.authorName) return thread.authorName;
  if (!thread.authorUserId) return 'We started this';
  return 'Name not on file';
}

// A thread's category comes from either taxonomy — the store's eight or the
// operator's five — which share two keys and not the rest. Both are consulted
// and the raw key is the last resort, because a thread whose category this
// console does not recognise must still open.
function categoryLabel(key: string): string {
  if (isSupportCategory(key)) return categoryMeta(key).label;
  return OPERATOR_CATEGORIES.find((c) => c.key === key)?.label ?? key;
}

// Where in the app, in the store's own words. `areaOther` is the free-text
// answer behind "Somewhere else" and is the more specific of the two whenever
// it is filled.
function areaLabel(thread: PlatformSupportThread): string | null {
  if (thread.areaOther) return thread.areaOther;
  if (!thread.area || !isSupportCategory(thread.category)) return thread.area;
  return categoryMeta(thread.category).areas.find((a) => a.key === thread.area)?.label ?? thread.area;
}

const styles = StyleSheet.create({
  stack: { gap: 14 },
  kpis: { flexDirection: 'row', gap: 24, flexWrap: 'wrap' },
  kpiValue: { fontSize: 22, fontWeight: '800', letterSpacing: -0.6, color: theme.bentoInk },
  kpiLabel: { fontSize: 10.5, color: theme.bentoMuted },
  kpiHint: { fontSize: 10, color: theme.bentoMuted2 },
  filters: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 12 },
  newButton: {
    backgroundColor: theme.bentoInk,
    borderRadius: 999,
    paddingVertical: 7,
    paddingHorizontal: 14,
  },
  newButtonText: { fontSize: 11.5, fontWeight: '800', color: theme.bentoSurface },
  empty: { fontSize: 13, color: theme.bentoMuted, paddingVertical: 16 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 12,
    borderTopWidth: 1,
    borderTopColor: theme.bentoRule,
  },
  rowText: { flex: 1, minWidth: 0 },
  subject: { fontSize: 13, fontWeight: '700', color: theme.bentoInk },
  meta: { fontSize: 10.5, color: theme.bentoMuted2 },
  waChip: { backgroundColor: theme.bentoUpWash, borderRadius: 999, paddingVertical: 3, paddingHorizontal: 9 },
  waChipText: { fontSize: 10.5, fontWeight: '800', color: theme.bentoUpInk },
  stateChip: { backgroundColor: theme.bentoSoft, borderRadius: 999, paddingVertical: 3, paddingHorizontal: 9 },
  stateUrgent: { backgroundColor: theme.bentoDownWash },
  stateText: { fontSize: 10.5, fontWeight: '800', color: theme.bentoMuted2 },
  stateTextUrgent: { color: theme.bentoDownInk },
});

const panelStyles = StyleSheet.create({
  wrap: { gap: 14 },
  wrapWide: { flexDirection: 'row' },
  main: { minWidth: 0 },
  rail: { minWidth: 0, gap: 12 },
  // 1.55 : 1 — the conversation is what you read, the rail is what you glance
  // at. Only side by side: `flex` implies a zero basis, and a zero-basis child
  // of the modal's auto-height ScrollView has no free space to grow into, so
  // stacked these two would lay out at no height at all.
  mainWide: { flex: 1.55 },
  railWide: { flex: 1 },
  threadMeta: { fontSize: 11, color: theme.bentoMuted, marginBottom: 14 },
  loading: { marginVertical: 24 },
  bubble: { borderRadius: 16, padding: 13, marginBottom: 10 },
  fromShop: { backgroundColor: theme.bentoSoft },
  fromUs: { backgroundColor: theme.bentoAccentWash },
  author: { fontSize: 11.5, fontWeight: '800', color: theme.bentoInk },
  authorUs: { color: theme.bentoAccentInk },
  body: { fontSize: 12.5, color: theme.bentoInk2, marginTop: 4 },
  bodyUs: { color: theme.bentoAccentInk },
  attachment: { fontSize: 12, fontWeight: '700', color: theme.bentoAccentInk, marginTop: 8 },
  input: {
    borderWidth: 1,
    borderColor: theme.bentoRule,
    borderRadius: 12,
    padding: 12,
    minHeight: 90,
    fontSize: 13.5,
    color: theme.bentoInk,
    textAlignVertical: 'top',
  },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10, marginBottom: 4 },
  railCard: { backgroundColor: theme.bentoSoft, borderRadius: 16, padding: 14 },
  railTitle: {
    fontSize: 9.5,
    fontWeight: '800',
    letterSpacing: 1,
    color: theme.bentoMuted2,
    marginBottom: 9,
  },
  // The first row in each card draws a top rule it does not need; that is
  // deliberate — every card's rows then rule identically, rather than the first
  // one being a special case in three places.
  railRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: 12,
    paddingVertical: 6,
    borderTopWidth: 1,
    borderTopColor: theme.bentoRule,
  },
  railKey: { fontSize: 12, color: theme.bentoMuted },
  railValueWrap: { flexDirection: 'row', alignItems: 'center', gap: 7, flexShrink: 1 },
  railValue: { fontSize: 12, fontWeight: '700', color: theme.bentoInk, textAlign: 'right' },
  railAction: {
    borderWidth: 1,
    borderColor: theme.bentoUpInk,
    borderRadius: 999,
    paddingVertical: 3,
    paddingHorizontal: 9,
  },
  railActionText: { fontSize: 11, fontWeight: '800', color: theme.bentoUpInk },
});
