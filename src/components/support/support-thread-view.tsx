import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { AttachmentPicker } from '@/components/support/attachment-picker';
import { supportStyles } from '@/components/support/support-styles';
import { Caveat } from '@/components/ui/caveat';
import { Colors } from '@/constants/theme';
import { useAuth } from '@/hooks/use-auth';
import { openExternalUrl } from '@/lib/external-url';
import { listMessages, markThreadRead, postReply, type SupportMessage, type SupportThread } from '@/lib/support';
import {
  attachToMessage,
  missedAttachmentNote,
  signedUrlFor,
  type PendingAttachment,
} from '@/lib/support-attachments';

// The light palette, for the same reason support-compose.tsx takes it: this
// renders inside the support sheet, which is a bento surface.
const theme = Colors.light;

// Which thing to retry travels with the message because three different things
// fail here -- the load, a reply, opening an attachment -- and a 'wrong' caveat
// owes the reader the fix for the thing that actually broke. A single "Try
// again" that always reloaded the conversation would be the wrong button under
// two of them, and would clear the caveat while the reply still sat unsent.
// Named rather than a closure so no handler has to reference itself.
type Problem = { message: string; retry: 'load' | 'send' | { attachment: string } };

export function SupportThreadView({ thread, onBack }: { thread: SupportThread; onBack: () => void }) {
  const { session } = useAuth();
  const [messages, setMessages] = useState<SupportMessage[] | null>(null);
  const [reply, setReply] = useState('');
  const [files, setFiles] = useState<PendingAttachment[]>([]);
  const [problem, setProblem] = useState<Problem | null>(null);
  // A qualification on a reply that arrived, never a failure. Held apart from
  // `problem` for that reason: a 'wrong' caveat here would read as "your reply
  // did not send", and the action that follows from that is to write it again.
  const [missedFiles, setMissedFiles] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  // `disabled` alone is not a guard: two press events landing before the
  // `sending` state has re-rendered the button both see it enabled, and
  // `postReply` is a plain insert with nothing on the server to collapse the
  // second one into the first. Checked and set synchronously, so the second
  // press is turned away before either await starts.
  const sendInFlight = useRef(false);

  // A promise chain rather than async/await: react-hooks/set-state-in-effect
  // reads a setState after an `await` as a synchronous one and fails the effect
  // that calls this, while the same setState inside a `.then` is what the rule
  // asks for.
  const load = useCallback((): Promise<void> => {
    return listMessages(thread.id)
      .then((loaded) => {
        setMessages(loaded);
        setProblem(null);
        // Marking read on open rather than on close: someone who reads a reply
        // and switches apps has still read it, and a badge that survives that
        // is a badge people learn to ignore.
        //
        // Its failure is swallowed, and separately from the load: the
        // conversation is on screen and readable, so an error here would point
        // at the wrong thing entirely. The only visible consequence is that the
        // badge and the Unread pill stay up -- which is exactly what the server
        // knows, since the write never landed. Opening it again retries.
        return markThreadRead(thread.id).catch(() => {});
      })
      .catch((error: unknown) => {
        setProblem({
          message: error instanceof Error ? error.message : 'Could not load this conversation.',
          retry: 'load',
        });
      });
  }, [thread.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const send = async (): Promise<void> => {
    if (!reply.trim() || !session || sendInFlight.current) return;
    sendInFlight.current = true;
    setSending(true);
    setProblem(null);
    setMissedFiles(null);
    try {
      const message = await postReply(thread.id, reply, session.user.id);
      setReply('');
      // Past here the words have arrived. Uploading cannot throw and cannot
      // undo that, so a refused file is reported beside a sent reply rather
      // than as a send that failed -- the alternative is somebody re-typing a
      // message we already have, which is how one lost screenshot becomes two
      // of the same reply.
      const missed = await attachToMessage(thread.shopId, thread.id, message.id, files);
      setFiles([]);
      setMissedFiles(missedAttachmentNote(missed));
      // Reloads rather than appending: this also re-marks the thread read, so
      // your own reply -- which moves last_message_at forward -- does not raise
      // the badge against you. Unless that particular read-mark is the thing
      // that fails: it is swallowed inside load() (see the comment there), so
      // a reply that posts but whose read-mark does not lands with the badge
      // up against its own author until the thread is reopened. Considered
      // and accepted rather than missed -- reopening is the same retry load()
      // already gives every other failed read-mark, and a second special case
      // here would only buy back a rare, low-cost miss.
      await load();
    } catch (error) {
      setProblem({
        message: error instanceof Error ? error.message : 'That did not send.',
        retry: 'send',
      });
    } finally {
      sendInFlight.current = false;
      setSending(false);
    }
  };

  const openAttachment = async (storagePath: string): Promise<void> => {
    try {
      // Signed first, then handed to the wrapper rather than
      // `Linking.openURL` directly: on web a blocked/failed `window.open`
      // sometimes reuses the *current* tab instead of a new one, which here
      // would navigate away from the sheet mid-conversation and take an
      // unsent reply and any picked attachments with it.
      const url = await signedUrlFor(storagePath);
      openExternalUrl(url);
    } catch {
      setProblem({ message: 'Could not open that file.', retry: { attachment: storagePath } });
    }
  };

  const retryProblem = () => {
    if (!problem) return;
    // Cleared first so the retry is visible: the spinner below is suppressed
    // while a problem is on screen, and a "Try again" that leaves the caveat
    // sitting there looks like it did nothing.
    setProblem(null);
    if (problem.retry === 'load') void load();
    else if (problem.retry === 'send') void send();
    else void openAttachment(problem.retry.attachment);
  };

  return (
    <View>
      <Pressable onPress={onBack} hitSlop={8} accessibilityRole="button">
        <Text style={styles.back}>‹ All messages</Text>
      </Pressable>
      <Text style={styles.subject}>{thread.subject}</Text>
      <Text style={styles.meta}>
        {thread.reference} · {thread.status === 'open' ? 'Open' : 'Closed'}
        {thread.openedBy === 'platform' ? ' · From Kaiibi' : ''}
      </Text>

      {messages === null ? (
        // No spinner under a failure: nothing is still loading once the load
        // has answered with an error, and a spinner that never stops reads as
        // a frozen screen rather than a failed one.
        problem === null && <ActivityIndicator style={styles.loading} />
      ) : (
        messages.map((message) => (
          <View
            key={message.id}
            style={[styles.bubble, message.authorKind === 'platform' ? styles.fromUs : styles.fromShop]}
          >
            <Text style={[styles.author, message.authorKind === 'platform' && styles.authorUs]}>
              {message.authorKind === 'platform' ? 'Kaiibi support' : 'You'}
            </Text>
            <Text style={[styles.body, message.authorKind === 'platform' && styles.bodyUs]}>{message.body}</Text>
            {message.attachments.map((attachment) => (
              <Pressable
                key={attachment.id}
                onPress={() => openAttachment(attachment.storagePath)}
                accessibilityRole="link"
              >
                <Text style={styles.attachment}>📎 {attachment.fileName}</Text>
              </Pressable>
            ))}
          </View>
        ))
      )}

      {thread.status === 'open' && (
        <>
          <Text style={[supportStyles.label, styles.label]}>Reply</Text>
          <TextInput
            value={reply}
            onChangeText={setReply}
            placeholder="Write back…"
            placeholderTextColor={theme.bentoMuted2}
            multiline
            style={[supportStyles.input, styles.input]}
          />

          {/* The whole point of a reply box that can attach: a store asked for
              a screenshot, or one that lost a file on the first message, has
              somewhere to put it. Before this the only picker in the product
              was on the very first message. */}
          <Text style={[supportStyles.label, styles.label]}>Attachments — optional</Text>
          <AttachmentPicker files={files} onChange={setFiles} />

          <Pressable
            onPress={send}
            disabled={!reply.trim() || sending}
            style={[supportStyles.send, styles.send, (!reply.trim() || sending) && supportStyles.sendOff]}
            accessibilityRole="button"
          >
            <Text
              style={[supportStyles.sendText, styles.sendText, (!reply.trim() || sending) && supportStyles.sendTextOff]}
            >
              {sending ? 'Sending…' : 'Send reply'}
            </Text>
          </Pressable>
        </>
      )}

      {missedFiles && (
        <Caveat tone="context" onDismiss={() => setMissedFiles(null)}>
          {missedFiles}
        </Caveat>
      )}

      {problem && (
        <Caveat tone="wrong" action={{ label: 'Try again', onPress: retryProblem }}>
          {problem.message}
        </Caveat>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  back: { fontSize: 12, fontWeight: '800', color: theme.bentoMuted, marginBottom: 10 },
  subject: { fontSize: 17, fontWeight: '800', letterSpacing: -0.3, color: theme.bentoInk },
  meta: { fontSize: 11.5, color: theme.bentoMuted, marginTop: 3, marginBottom: 14 },
  loading: { marginVertical: 24 },
  bubble: { borderRadius: 16, padding: 13, marginBottom: 10 },
  fromShop: { backgroundColor: theme.bentoSoft },
  fromUs: { backgroundColor: theme.bentoAccentWash },
  author: { fontSize: 11.5, fontWeight: '800', color: theme.bentoInk },
  authorUs: { color: theme.bentoAccentInk },
  body: { fontSize: 13, color: theme.bentoInk2, marginTop: 4 },
  bodyUs: { color: theme.bentoAccentInk },
  attachment: { fontSize: 12, fontWeight: '700', color: theme.bentoAccentInk, marginTop: 8 },
  // Only what genuinely differs from support-styles.ts lives here: this
  // form's label sits closer to the bubbles above it than compose's does, and
  // its input is a fixed-height reply box rather than a growing field.
  label: { marginTop: 12 },
  input: { padding: 12, minHeight: 80, textAlignVertical: 'top' },
  send: { marginTop: 12, paddingVertical: 12 },
  sendText: { fontSize: 13 },
});
