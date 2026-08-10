import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { Chip, PlatformButton, PlatformModal, SectionLabel } from '@/components/platform/kit';
import { coverEnd, fmtDate } from '@/components/platform/labels';
import { BentoCard } from '@/components/ui/bento-card';
import { Caveat } from '@/components/ui/caveat';
import { SubscriptionStatusPill } from '@/components/ui/subscription-status';
import { Colors } from '@/constants/theme';
import { formatCents, formatForeignCents } from '@/lib/currency';
import { openExternalUrl } from '@/lib/external-url';
import {
  callPlatformAdmin,
  supportQueueState,
  type PlatformShopRow,
  type PlatformSupportThread,
  type SubscriptionPaymentRow,
} from '@/lib/platform';
import { listMessages, whatsAppLink, type SupportMessage } from '@/lib/support';
import { signedUrlFor } from '@/lib/support-attachments';
import {
  FILTER_CATEGORIES,
  OPERATOR_CATEGORIES,
  categoryMeta,
  isSupportCategory,
  type OperatorCategory,
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
  payments,
  now,
  truncated,
  compact,
  onDone,
  onCompose,
}: {
  threads: PlatformSupportThread[];
  shops: PlatformShopRow[];
  /**
   * Every payment the console loaded. Billing is the largest support category
   * and "has my payment gone through" is the question behind most of it, so the
   * rail answers it from data already on the screen rather than sending the
   * operator to the Stores tab mid-reply.
   */
  payments: SubscriptionPaymentRow[];
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
          {FILTER_CATEGORIES.map((category) => (
            <Chip
              key={category.key}
              label={`${category.label} ${threads.filter((t) => t.category === category.key).length}`}
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
            payments={payments.filter((p) => p.shopId === opened.shopId)}
            wide={!compact}
            onDone={onDone}
            onClose={() => setOpenedId(null)}
          />
        </PlatformModal>
      )}
    </View>
  );
}

// Who at the store an outbound thread belongs to.
//
// Held as a mode rather than as the id it resolves to: the id is only knowable
// once a store is chosen, and a uuid in state would survive the operator
// clearing the store — addressing the next store's thread to the last store's
// owner, which the edge function would refuse and, if it ever stopped refusing,
// would be this feature's one promise broken.
type Recipient = 'store' | 'owner';

// support_messages.body's own ceiling (20260825000000), restated by
// platform-admin so the check violation becomes a sentence. Restated a third
// time here for one reason only: a 4100-character message that has to reach the
// server to be refused is a message the operator has to write twice.
const MESSAGE_MAX = 4000;

// Code points, because that is what Postgres length() counts and what the edge
// function measures against. Plain .length is UTF-16 units, which counts every
// emoji twice.
const bodyLength = (text: string) => [...text].length;

/**
 * Starting a conversation, rather than answering one.
 *
 * The same object either way — a thread — so this is the reply panel with its
 * fields flipped: a recipient instead of an identity strip, because the one
 * thing an outbound message has to get right is who at the store can read it.
 *
 * ONE STORE AT A TIME. The recipient row would take several as easily as one,
 * and must not: "message every store on Starter" is a broadcast, which is a
 * different feature with different failure modes — an announcement hundreds of
 * stores cannot reply to, turning the unread badge into noise people learn to
 * dismiss — and it needs a reply-disabled thread type that does not exist.
 */
export function SupportComposeModal({
  shops,
  initialShopId,
  onDone,
  onClose,
}: {
  shops: PlatformShopRow[];
  /** Pre-filled when the composer was opened from a store's drawer. */
  initialShopId: string | null;
  /** Reloads the console, so the new thread appears in the queue behind this. */
  onDone: () => Promise<void>;
  onClose: () => void;
}) {
  const [shopId, setShopId] = useState<string | null>(initialShopId);
  const [search, setSearch] = useState('');
  const [recipient, setRecipient] = useState<Recipient>('store');
  const [category, setCategory] = useState<OperatorCategory>('billing');
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // `busy` alone is not a guard: two presses landing before the state has
  // re-rendered the button both see it enabled, and open_support is an insert
  // with nothing on the server to collapse the second into the first — the
  // store would get the same message twice, in two separate conversations.
  const sendInFlight = useRef(false);

  const matches = useMemo(() => {
    const q = search.trim().toLowerCase();
    // Nothing until they type. This console lists every store on Kaiibi, and a
    // recipient field that opens with an arbitrary six of them invites picking
    // whichever one looks closest.
    if (!q) return [];
    return shops.filter((shop) => shop.shopName.toLowerCase().includes(q)).slice(0, 6);
  }, [shops, search]);

  const chosen = shops.find((shop) => shop.shopId === shopId) ?? null;
  const body = message.trim();
  const tooLong = bodyLength(body) > MESSAGE_MAX;

  const send = async (): Promise<void> => {
    if (!chosen) {
      setError('Pick a store first.');
      return;
    }
    if (!subject.trim() || !body) {
      setError('A subject and a message are both needed.');
      return;
    }
    if (tooLong) {
      setError(`That message is ${bodyLength(body)} characters; the limit is ${MESSAGE_MAX}.`);
      return;
    }
    if (sendInFlight.current) return;
    sendInFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      // The message body is passed as `reason`. platform-admin requires one on
      // every action, and for support the body IS the justification, so the
      // audit log records what was actually said rather than a second sentence
      // about it.
      //
      // addressedUserId null means "the store", which the policy in
      // 20260825000000 reads as holders of settings.access — not everyone at
      // the shop. An id makes the thread that person's alone. The owner's is
      // the only id this console can name (see RECIPIENTS).
      await callPlatformAdmin(
        'open_support',
        {
          shopId: chosen.shopId,
          support: {
            category,
            subject: subject.trim(),
            addressedUserId: recipient === 'owner' ? chosen.ownerId : null,
          },
        },
        body
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That message did not send.');
      return;
    } finally {
      sendInFlight.current = false;
      setBusy(false);
    }

    // Past here the thread exists. Closing BEFORE the reload rather than after
    // it: a composer left open over a failed console refresh still holds the
    // draft of a message that has already been sent, and "Try again" on it
    // opens the same conversation a second time. The console owns its own
    // reload failure -- it has an error state and a Try again of its own.
    onClose();
    await onDone();
  };

  return (
    <View>
      <Text style={composeStyles.label}>To</Text>
      {chosen ? (
        <Pressable
          onPress={() => {
            setShopId(null);
            // Back to the store, not left on the last store's owner: the
            // recipient is a choice about a shop that is no longer picked.
            setRecipient('store');
          }}
          style={composeStyles.token}
        >
          <Text style={composeStyles.tokenText}>{chosen.shopName}  ✕</Text>
        </Pressable>
      ) : (
        <>
          {/* The drawer hands over an id, not a row, so a store the console
              reloaded away from — or never held — lands here as an empty search
              box. Unexplained, that reads as "I opened the wrong thing", and the
              operator closes a composer that was addressed correctly. */}
          {shopId ? (
            <Caveat tone="wrong" action={{ label: 'Search for it', onPress: () => setShopId(null) }}>
              That store is not in the list this console has loaded, so it could not be filled in
              here. Find it by name below, or reload the console and start again.
            </Caveat>
          ) : null}
          <TextInput
            value={search}
            onChangeText={setSearch}
            placeholder="Search stores…"
            placeholderTextColor={theme.bentoMuted2}
            style={composeStyles.input}
          />
          {matches.map((shop) => (
            <Pressable
              key={shop.shopId}
              onPress={() => {
                setShopId(shop.shopId);
                setSearch('');
              }}
              style={composeStyles.match}
            >
              <Text style={composeStyles.matchText}>{shop.shopName}</Text>
            </Pressable>
          ))}
        </>
      )}

      {chosen && (
        <>
          <Text style={composeStyles.label}>Who at the store</Text>
          <View style={composeStyles.chips}>
            {RECIPIENTS.map((option) => (
              <Chip
                key={option.key}
                label={option.label}
                active={recipient === option.key}
                onPress={() => setRecipient(option.key)}
              />
            ))}
          </View>
          {/* The choice is a privacy guarantee, so it is spelled out rather
              than left to two words on a chip. Neither option means "everyone
              who works here", and an operator who believes it does will write
              a billing message a cashier is meant never to see. */}
          <Caveat tone="context">{recipientNote(recipient, chosen.shopName)}</Caveat>
        </>
      )}

      <Text style={composeStyles.label}>What&apos;s this about?</Text>
      <View style={composeStyles.chips}>
        {OPERATOR_CATEGORIES.map((option) => (
          <Chip
            key={option.key}
            label={`${option.glyph} ${option.label}`}
            active={category === option.key}
            onPress={() => setCategory(option.key)}
          />
        ))}
      </View>

      <Text style={composeStyles.label}>Subject</Text>
      <TextInput value={subject} onChangeText={setSubject} style={composeStyles.input} />

      <Text style={composeStyles.label}>Message</Text>
      <TextInput
        value={message}
        onChangeText={setMessage}
        multiline
        style={[composeStyles.input, composeStyles.area]}
      />
      {tooLong && (
        <Text style={composeStyles.overflow}>
          {`${bodyLength(body)} of ${MESSAGE_MAX} characters. Shorten it by ${bodyLength(body) - MESSAGE_MAX} to send.`}
        </Text>
      )}

      {error && (
        <Caveat tone="wrong" action={{ label: 'Try again', onPress: () => void send() }}>
          {error}
        </Caveat>
      )}

      <View style={composeStyles.actions}>
        {/* Quiet, so exactly one filled pill in the row names the ordinary
            thing to do. PlatformButton's default already is the filled one. */}
        <PlatformButton label="Cancel" quiet onPress={onClose} />
        <PlatformButton label={busy ? 'Sending…' : 'Send'} onPress={() => void send()} disabled={busy || tooLong} />
      </View>
    </View>
  );
}

// The two recipients this console can actually name.
//
// There is no third option and no member picker, because an operator cannot
// read a shop's roster: `shop_members` carries no policy for is_platform_admin()
// and verify-platform-portal.sql asserts that it stays that way — the staff
// list is one of the things a stolen operator account must not open. The
// owner's id rides on PlatformShopRow, which is why that one person can be
// named at all, and open_support accepts it without a roster lookup for the
// same reason. Offering names we would have to guess at is offering choices the
// edge function is going to refuse.
const RECIPIENTS: readonly { key: Recipient; label: string }[] = [
  { key: 'store', label: 'Everyone who runs it' },
  { key: 'owner', label: 'The owner only' },
];

function recipientNote(recipient: Recipient, shopName: string): string {
  if (recipient === 'owner') {
    return `Only the owner of ${shopName} can open this. Nobody else there sees it — not even colleagues who can reach Settings — and it stays theirs even if they leave the shop.`;
  }
  return `Anyone at ${shopName} who can reach Settings can read this and reply — the owner, and whoever they have trusted with the books. A cashier or a manager without that access will not see it at all.`;
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
//
// The hand-off is NOT in here. A browser that refuses to open the chat mostly
// does it without throwing (see handOffChat), so a retry conditioned on a
// caught error would be offered for the rare failure and withheld for the
// usual one. Its affordance is unconditional instead.
type Retry =
  | { kind: 'load' }
  | { kind: 'send'; opts: SendOptions }
  | { kind: 'close'; reason: string }
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
  payments,
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
  /** This store's payments only; the panel picks the most recent itself. */
  payments: SubscriptionPaymentRow[];
  wide: boolean;
  onDone: () => Promise<void>;
  onClose: () => void;
}) {
  const [messages, setMessages] = useState<SupportMessage[] | null>(null);
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  // The reply whose WhatsApp chat we have tried to open, held so the note that
  // offers a second, in-gesture attempt can carry the same text. Null until a
  // hand-off send has actually landed.
  const [handedOff, setHandedOff] = useState<string | null>(null);
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
  // Nothing here can tell whether it worked. Called from `send` this runs two
  // awaits after the operator's press, and a link click outside a user gesture
  // is what Chrome and Safari block — SILENTLY, no throw, no return value. So
  // this is best-effort only, and the note under the buttons offers the same
  // hand-off from a real press, where the browser has no reason to refuse it.
  const handOffChat = (text: string): void => {
    const link = whatsAppLink(thread.authorPhone, text);
    if (!link) return;
    try {
      openExternalUrl(link);
    } catch {
      // Deliberately not reported. A caught throw is the rarer half of the same
      // failure and has the same fix, which is already on screen; raising a
      // caveat only for this half would tell the operator nothing in the case
      // that actually happens.
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
    // Dropped before the send, not after it: the note names one reply, and
    // leaving the last one's up would offer to open a chat pre-filled with a
    // message the operator has already sent.
    setHandedOff(null);
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
      if (opts.whatsApp) {
        setHandedOff(body);
        handOffChat(body);
      }

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
    else void openAttachment(retry.path);
  };

  // Asked of the link rather than of the phone field, as whatsapp.ts asks
  // callers to: a number that cannot be dialled produces no link, and offering
  // to message someone we cannot reach is worse than not offering.
  const chatLink = whatsAppLink(thread.authorPhone);
  const cover = shop ? coverEnd(shop) : null;
  // Max by date rather than [0]: listSubscriptionPayments happens to sort
  // newest first, but "the last payment" is a claim this row makes on its own
  // and a re-ordered query elsewhere must not be able to make it a false one.
  const lastPayment = payments.reduce<SubscriptionPaymentRow | null>(
    (latest, p) => (latest && Date.parse(latest.paidAt) >= Date.parse(p.paidAt) ? latest : p),
    null
  );

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
                {authorLabel(thread, message)}
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
          <Caveat tone="context">{whatsAppNote(thread, chatLink)}</Caveat>
        )}
        {handedOff !== null && (
          // Unconditional after a hand-off send, and it stays. The automatic
          // attempt above cannot report whether the chat opened, so the only
          // honest thing to show is the way to open it again — and this press
          // IS the user gesture the blocked one lacked.
          <Caveat tone="context" action={{ label: 'Open WhatsApp', onPress: () => handOffChat(handedOff) }}>
            {
              'The reply is on the thread either way. Their chat should have opened in a new tab with it already written — if nothing appeared, your browser blocked it.'
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
          {/* The money question a store actually asks. Same shape as "Sent
              from": a row saying there is nothing, rather than no row at all,
              because a missing row reads as a rail that failed to load. */}
          <RailRow
            k="Last payment"
            v={lastPayment ? `${paymentAmount(lastPayment)} · ${fmtDate(lastPayment.paidAt)}` : 'None recorded'}
          />
          {lastPayment && <RailRow k="Matched" v={matchLabel(lastPayment, cover)} />}
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

// Who is waiting. `openedBy` is the discriminator, NOT the null author:
// `support_threads.author_user_id` is `on delete set null`, so a store-opened
// thread whose author has since been deleted arrives with the same empty
// author a thread we started does — and "We started this" over somebody else's
// question is the exact lie this label exists to prevent. The queue row asks
// `openedBy` for the same reason.
function personLabel(thread: PlatformSupportThread): string {
  if (thread.openedBy === 'platform') return 'We started this';
  if (thread.authorName) return thread.authorName;
  return 'Name not on file';
}

// Whose name goes on a bubble. A shop message is only the thread's author's
// when the ids match: a colleague replying on the same thread is a different
// person, and this list carries no name for them, so it says so rather than
// signing their message with somebody else's name.
function authorLabel(thread: PlatformSupportThread, message: SupportMessage): string {
  if (message.authorKind === 'platform') return 'Kaiibi support';
  if (message.authorUserId && message.authorUserId === thread.authorUserId) return personLabel(thread);
  return 'The store';
}

// The note under the send row, gated on the same fact the button is. Copy
// explaining a control that is not on screen sends the operator looking for it,
// and "they asked for WhatsApp" is still something they have to know in the
// case where we cannot hand them a chat.
function whatsAppNote(thread: PlatformSupportThread, chatLink: string | null): string {
  if (chatLink) {
    return 'They asked to be nudged on WhatsApp too. Send writes the reply into the thread as always; Send & open WhatsApp does that and then opens their chat with this reply already in the box. Kaiibi never sends the WhatsApp message itself — you do, from your own account.';
  }
  if (!thread.authorPhone) {
    return 'They asked to be nudged on WhatsApp, but there is no number on file for them, so there is no chat to open from here. Your reply in the thread is the only way they hear from us.';
  }
  return `They asked to be nudged on WhatsApp, but the number on file (${thread.authorPhone}) is not one we can dial, so there is no chat to open from here. Your reply in the thread is the only way they hear from us.`;
}

// The payment carries its own currency and every plan is priced in USD today,
// but printing a dollar sign over a shilling amount is the kind of wrong an
// operator quotes straight back to the store.
function paymentAmount(payment: SubscriptionPaymentRow): string {
  return payment.currency === 'USD'
    ? formatCents(payment.amountCents)
    : formatForeignCents(payment.amountCents, payment.currency);
}

// Whether their access is actually standing on the money they last sent.
//
// The payment row alone does not answer that: recording money only moves the
// period when the payment carried a cover date, and an extended trial or a
// second payment can move that period somewhere else afterwards. Compared by
// day rather than by instant — record_payment copies covers_to into
// current_period_end verbatim, so a difference in the time of day means the two
// were written by different actions, not that they disagree.
function matchLabel(payment: SubscriptionPaymentRow, cover: { ends: string | null } | null): string {
  if (!payment.coversTo) return 'No — it bought no cover';
  if (!cover?.ends) return 'Cannot tell — no cover on file';
  if (sameDay(payment.coversTo, cover.ends)) return `Yes — covers to ${fmtDate(payment.coversTo)}`;
  return `No — their cover ends ${fmtDate(cover.ends)}`;
}

function sameDay(a: string, b: string): boolean {
  const x = new Date(a);
  const y = new Date(b);
  if (Number.isNaN(x.getTime()) || Number.isNaN(y.getTime())) return false;
  return x.toISOString().slice(0, 10) === y.toISOString().slice(0, 10);
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

const composeStyles = StyleSheet.create({
  label: {
    fontSize: 9.5,
    fontWeight: '800',
    letterSpacing: 1,
    textTransform: 'uppercase',
    color: theme.bentoMuted2,
    marginTop: 16,
    marginBottom: 8,
  },
  input: {
    borderWidth: 1,
    borderColor: theme.bentoRule,
    borderRadius: 12,
    padding: 11,
    fontSize: 13.5,
    color: theme.bentoInk,
  },
  area: { minHeight: 110, textAlignVertical: 'top' },
  match: { paddingVertical: 9, borderTopWidth: 1, borderTopColor: theme.bentoRule },
  matchText: { fontSize: 13, fontWeight: '700', color: theme.bentoInk },
  token: {
    alignSelf: 'flex-start',
    backgroundColor: theme.bentoAccentWash,
    borderRadius: 999,
    paddingVertical: 5,
    paddingHorizontal: 12,
  },
  tokenText: { fontSize: 12, fontWeight: '800', color: theme.bentoAccentInk },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  overflow: { fontSize: 11.5, fontWeight: '700', color: theme.bentoLoss, marginTop: 6 },
  actions: { flexDirection: 'row', gap: 8, marginTop: 18, justifyContent: 'flex-end' },
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
