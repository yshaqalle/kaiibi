import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Linking, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { Caveat } from '@/components/ui/caveat';
import { Colors } from '@/constants/theme';
import { useAuth } from '@/hooks/use-auth';
import { listMessages, markThreadRead, postReply, type SupportMessage, type SupportThread } from '@/lib/support';
import { signedUrlFor } from '@/lib/support-attachments';

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
  const [problem, setProblem] = useState<Problem | null>(null);
  const [sending, setSending] = useState(false);

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
    if (!reply.trim() || !session) return;
    setSending(true);
    setProblem(null);
    try {
      await postReply(thread.id, reply, session.user.id);
      setReply('');
      // Reloads rather than appending: this also re-marks the thread read, so
      // your own reply -- which moves last_message_at forward -- does not raise
      // the badge against you.
      await load();
    } catch (error) {
      setProblem({
        message: error instanceof Error ? error.message : 'That did not send.',
        retry: 'send',
      });
    } finally {
      setSending(false);
    }
  };

  const openAttachment = async (storagePath: string): Promise<void> => {
    try {
      await Linking.openURL(await signedUrlFor(storagePath));
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
          <Text style={styles.label}>Reply</Text>
          <TextInput
            value={reply}
            onChangeText={setReply}
            placeholder="Write back…"
            placeholderTextColor={theme.bentoMuted2}
            multiline
            style={styles.input}
          />
          <Pressable
            onPress={send}
            disabled={!reply.trim() || sending}
            style={[styles.send, (!reply.trim() || sending) && styles.sendOff]}
            accessibilityRole="button"
          >
            <Text style={[styles.sendText, (!reply.trim() || sending) && styles.sendTextOff]}>
              {sending ? 'Sending…' : 'Send reply'}
            </Text>
          </Pressable>
        </>
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
  label: {
    fontSize: 9.5,
    fontWeight: '800',
    letterSpacing: 1,
    textTransform: 'uppercase',
    color: theme.bentoMuted2,
    marginTop: 12,
    marginBottom: 8,
  },
  input: {
    borderWidth: 1,
    borderColor: theme.bentoRule,
    borderRadius: 12,
    padding: 12,
    minHeight: 80,
    fontSize: 13.5,
    color: theme.bentoInk,
    textAlignVertical: 'top',
  },
  send: { marginTop: 12, backgroundColor: theme.bentoInk, borderRadius: 999, paddingVertical: 12, alignItems: 'center' },
  sendOff: { backgroundColor: theme.bentoSoft },
  sendText: { fontSize: 13, fontWeight: '800', color: theme.bentoSurface },
  sendTextOff: { color: theme.bentoMuted2 },
});
