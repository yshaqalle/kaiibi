import Constants from 'expo-constants';
import { usePathname } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { AttachmentPicker } from '@/components/support/attachment-picker';
import { supportStyles } from '@/components/support/support-styles';
import { Caveat } from '@/components/ui/caveat';
import { Colors } from '@/constants/theme';
import { useAuth } from '@/hooks/use-auth';
import { isTabletDevice } from '@/lib/device';
import {
  buildClientContext,
  createThread,
  validateDraft,
  type ContactPreference,
  type SupportDraft,
} from '@/lib/support';
import { attachmentPath, uploadAttachment, type PendingAttachment } from '@/lib/support-attachments';
import {
  clearStoredDraft,
  readStoredDraft,
  writeStoredDraft,
  type StoredDraft,
} from '@/lib/support-draft';
import {
  categoryMeta,
  needsAreaOther,
  SUPPORT_CATEGORIES,
  type SupportCategory,
} from '@/lib/support-taxonomy';
import { supabase } from '@/lib/supabase';
import { personInitials, shortPersonName } from '@/lib/user-identity';

// The light palette, because this form renders inside the support sheet, which
// is a bento surface. The menu row beside it takes a `tone` prop for the
// opposite reason -- it is dropped into a sheet painted with Colors.dark.
const theme = Colors.light;

const EMPTY_DRAFT: SupportDraft = {
  category: null,
  area: null,
  areaOther: '',
  subject: '',
  details: '',
  contactPreference: 'in_app',
};

export function SupportCompose({ onSent }: { onSent: (reference: string) => void }) {
  const { session, profile, shop, myMembership, activeLocation, entitlements } = useAuth();
  const pathname = usePathname();

  const [draft, setDraft] = useState<SupportDraft>(EMPTY_DRAFT);
  const [files, setFiles] = useState<PendingAttachment[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const [missedFiles, setMissedFiles] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  // Opening a thread is not idempotent, so a send must never file a second copy
  // of a report that already landed. `draft` is the exact object the thread was
  // filed with: identity is the test, because any edit replaces it, and a thread
  // carrying the old words is not the one this send is trying to finish.
  const opened = useRef<{ thread: NonNullable<StoredDraft['thread']>; draft: SupportDraft } | null>(null);

  // The key is per user -- shop is not a narrow enough scope for a form people
  // write about each other in, and a shop tablet is signed in and out of all day.
  const userId = session?.user?.id ?? null;

  // Restore once, then persist on every change. Nothing typed is lost to a
  // failed send, a closed sheet, or a killed app. State rather than a ref
  // because the flip has to re-run the persist below: keystrokes typed while
  // the read was in flight would otherwise sit unpersisted until the next one.
  const [restored, setRestored] = useState(false);
  // The restore callback closes over the draft as it was when the effect ran,
  // which is always the empty one; this is what it actually is by the time the
  // read answers.
  const latestDraft = useRef(draft);
  useEffect(() => {
    latestDraft.current = draft;
  }, [draft]);

  useEffect(() => {
    if (!userId) return;
    void readStoredDraft(userId).then((stored) => {
      // Anything typed while the read was in flight wins: the restore is a
      // convenience, and overwriting live keystrokes with it is the one way
      // this feature could itself lose what someone wrote.
      if (stored && latestDraft.current === EMPTY_DRAFT) {
        opened.current = stored.thread ? { thread: stored.thread, draft: stored.draft } : null;
        setDraft(stored.draft);
      }
      setRestored(true);
    });
  }, [userId]);

  useEffect(() => {
    // Held until the restore has answered, so the empty first render cannot
    // erase the draft it is about to be replaced by.
    if (!restored || !userId) return;
    // A send clears the stored draft and then empties this one; persisting
    // EMPTY_DRAFT here would put the record straight back, making the clear a
    // no-op and leaving an empty husk under this user's key.
    if (draft === EMPTY_DRAFT) return;
    writeStoredDraft(userId, draft, opened.current?.draft === draft ? opened.current.thread : null);
  }, [draft, restored, userId]);

  const meta = draft.category ? categoryMeta(draft.category) : null;
  const showAreaOther = draft.category ? needsAreaOther(draft.category, draft.area) : false;

  const email = session?.user?.email ?? null;
  const personName = profile?.fullName ?? myMembership?.fullName ?? null;
  const phone = profile?.phone ?? null;
  const role = profile?.role === 'admin' ? 'Owner' : (myMembership?.roleName ?? null);

  const context = useMemo(
    () =>
      buildClientContext({
        appVersion: Constants.expoConfig?.version ?? null,
        buildNumber:
          Platform.OS === 'ios'
            ? (Constants.expoConfig?.ios?.buildNumber ?? null)
            : (Constants.expoConfig?.android?.versionCode?.toString() ?? null),
        platform: Platform.OS,
        isTablet: isTabletDevice(),
        screen: pathname,
        locationName: activeLocation?.name ?? null,
      }),
    [pathname, activeLocation]
  );

  const pickCategory = (category: SupportCategory) => {
    // Clearing the area matters: the areas are per-category, so keeping 'pos'
    // after switching to Billing would store a key that category has never
    // heard of.
    setDraft((d) => ({ ...d, category, area: null, areaOther: '' }));
    setProblem(null);
  };

  // Deliberately cannot throw. Once the thread is open the report has arrived,
  // and everything after this point is a qualification on a sent message rather
  // than grounds to tell someone their words went nowhere. Returns the names of
  // the files that did not make it.
  const attachFiles = async (shopId: string, threadId: string): Promise<string[]> => {
    if (files.length === 0) return [];
    try {
      // The RPC returns the thread row and nothing else, so the id of the
      // message it wrote alongside it still has to be asked for -- an
      // attachment hangs off a message, not off a thread. The thread is
      // seconds old, so the oldest message is the one just written.
      const { data: message, error } = await supabase
        .from('support_messages')
        .select('id')
        .eq('thread_id', threadId)
        .order('created_at', { ascending: true })
        .limit(1)
        .single();
      if (error) throw error;

      const missed: string[] = [];
      for (const [index, file] of files.entries()) {
        try {
          // `Date.now() + index` rather than Date.now(): the timestamp is only
          // there to keep paths unique, uploads use upsert:false, and two files
          // of the same name picked from different folders can finish inside
          // the same millisecond -- which would fail the second one.
          const path = attachmentPath(shopId, threadId, file.fileName, Date.now() + index);
          await uploadAttachment(path, file);
          const { error: linkError } = await supabase.from('support_attachments').insert({
            message_id: message.id,
            storage_path: path,
            file_name: file.fileName,
            byte_size: file.byteSize,
            content_type: file.contentType,
          });
          if (linkError) throw linkError;
        } catch {
          // One file failing says nothing about the next one.
          missed.push(file.fileName);
        }
      }
      return missed;
    } catch {
      // Without the message id nothing could be hung off it, so none of them
      // landed.
      return files.map((file) => file.fileName);
    }
  };

  const send = async () => {
    const validation = validateDraft(draft);
    if (!validation.ok) {
      setProblem(validation.message);
      return;
    }
    if (!shop || !session || !userId) return;

    setSending(true);
    setProblem(null);
    setMissedFiles(null);

    let thread = opened.current?.draft === draft ? opened.current.thread : null;
    if (!thread) {
      try {
        // No author argument: the RPC behind this reads auth.uid() itself.
        const created = await createThread(shop.id, draft, context);
        thread = { id: created.id, reference: created.reference };
      } catch (error) {
        // The draft is deliberately left alone. Nothing typed is ever lost to a
        // failed send -- retyping a bug report is how people stop reporting bugs.
        setProblem(error instanceof Error ? error.message : 'That did not send. Try again in a moment.');
        setSending(false);
        return;
      }
      // Stored before a single byte is uploaded. Closing the sheet mid-send
      // unmounts this component and the refs with it; the next Send would
      // otherwise file a second copy of a report that already landed and leave
      // the first unanswerable.
      opened.current = { thread, draft };
      writeStoredDraft(userId, draft, thread);
    }

    const missed = await attachFiles(shop.id, thread.id);

    clearStoredDraft(userId);
    opened.current = null;
    setDraft(EMPTY_DRAFT);
    setFiles([]);
    // Says what to do, not what to retry. A store can only attach on the first
    // message -- the reply box in support-thread-view.tsx has no picker -- so
    // telling someone to reopen the thread and try again would send the one
    // person who has just lost a file to a dead end.
    if (missed.length === 1) {
      setMissedFiles(`Sent — but ${missed[0]} didn't attach. Reply on the conversation and we'll ask you for it.`);
    } else if (missed.length > 1) {
      setMissedFiles(
        `Sent — but ${missed.length} files didn't attach. Reply on the conversation and we'll ask you for them.`
      );
    }
    setSending(false);
    onSent(thread.reference);
  };

  const complete = validateDraft(draft).ok;

  return (
    <View>
      <Text style={[supportStyles.label, styles.label]}>Sent as</Text>
      <View style={styles.who}>
        <View style={styles.avatar}>
          <Text style={styles.avatarText}>{personInitials(personName, email)}</Text>
        </View>
        <View style={styles.whoText}>
          <Text style={styles.whoName}>
            {shortPersonName(personName, email)}
            {role ? ` · ${role}` : ''}
          </Text>
          <Text style={styles.whoLine}>
            {[shop?.name, entitlements.planName, activeLocation?.name].filter(Boolean).join(' · ')}
          </Text>
          <Text style={styles.whoLine}>{[email, phone].filter(Boolean).join(' · ')}</Text>
          <Text style={styles.auto}>Attached automatically: {Object.values(context).join(' · ')}</Text>
        </View>
      </View>

      <Text style={[supportStyles.label, styles.label]}>What&apos;s this about?</Text>
      <View style={styles.chips}>
        {SUPPORT_CATEGORIES.map((category) => {
          const on = draft.category === category.key;
          return (
            <Pressable
              key={category.key}
              onPress={() => pickCategory(category.key)}
              style={[styles.chip, on && styles.chipOn]}
              accessibilityRole="button"
              accessibilityState={{ selected: on }}
            >
              <Text style={[styles.chipText, on && styles.chipTextOn]}>
                {category.glyph} {category.label}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {meta?.areaLabel && (
        <>
          <Text style={[supportStyles.label, styles.label]}>{meta.areaLabel}</Text>
          <View style={styles.chips}>
            {meta.areas.map((area) => {
              const on = draft.area === area.key;
              return (
                <Pressable
                  key={area.key}
                  onPress={() => setDraft((d) => ({ ...d, area: on ? null : area.key, areaOther: '' }))}
                  style={[styles.chip, on && styles.chipOn]}
                  accessibilityRole="button"
                  accessibilityState={{ selected: on }}
                >
                  <Text style={[styles.chipText, on && styles.chipTextOn]}>{area.label}</Text>
                </Pressable>
              );
            })}
          </View>
          <Text style={styles.hint}>Optional — it just helps us send this to the right place.</Text>
        </>
      )}

      {showAreaOther && (
        <View style={styles.reveal}>
          <Text style={[supportStyles.label, styles.label]}>Then what is it about?</Text>
          <TextInput
            value={draft.areaOther}
            onChangeText={(areaOther) => setDraft((d) => ({ ...d, areaOther }))}
            placeholder="A few words"
            placeholderTextColor={theme.bentoMuted2}
            style={[supportStyles.input, styles.input]}
          />
          <Text style={styles.hint}>This is how we find out what belongs on the list above.</Text>
        </View>
      )}

      {/* Billing is the category most likely to be about money already sent
          and not yet matched by hand, so the plan they are on belongs on
          screen before they describe the problem. */}
      {draft.category === 'billing' && (
        <Caveat tone="context">
          {`Your plan: ${entitlements.planName}. A ZAAD or eDahab payment is matched by hand, so if you've just paid, attach the confirmation SMS and we'll clear it faster.`}
        </Caveat>
      )}

      <Text style={[supportStyles.label, styles.label]}>Subject</Text>
      <TextInput
        value={draft.subject}
        onChangeText={(subject) => setDraft((d) => ({ ...d, subject }))}
        placeholder="A short line — &quot;Scanner stops after a refund&quot;"
        placeholderTextColor={theme.bentoMuted2}
        style={[supportStyles.input, styles.input]}
      />

      <Text style={[supportStyles.label, styles.label]}>{meta?.detailsLabel ?? 'Details'}</Text>
      <TextInput
        value={draft.details}
        onChangeText={(details) => setDraft((d) => ({ ...d, details }))}
        placeholder={meta ? '' : 'Pick a category above and we will tell you what is most useful to include.'}
        placeholderTextColor={theme.bentoMuted2}
        multiline
        style={[supportStyles.input, styles.input, styles.area]}
      />
      {meta && <Text style={styles.hint}>{meta.detailsHint}</Text>}

      <Text style={[supportStyles.label, styles.label]}>Attachments — optional</Text>
      <AttachmentPicker files={files} onChange={setFiles} />

      <Text style={[supportStyles.label, styles.label]}>Reply to me on</Text>
      <View style={styles.chips}>
        {(
          [
            { key: 'in_app', label: 'In the app', sub: 'here, under Your messages' },
            ...(phone ? [{ key: 'whatsapp' as const, label: 'WhatsApp', sub: phone }] : []),
            // No 'email' chip. The value survives in the check constraint and in
            // ContactPreference because rows already carry it, but nothing an
            // operator can see ever shows an address: no chip in the queue row,
            // no row in the context rail, and support_author_profiles()
            // (20260825000400) returns id, full_name and phone deliberately.
            // Offering it was a promise with nobody on the other end of it.
          ] as { key: ContactPreference; label: string; sub: string }[]
        ).map((option) => {
          const on = draft.contactPreference === option.key;
          return (
            <Pressable
              key={option.key}
              onPress={() => setDraft((d) => ({ ...d, contactPreference: option.key }))}
              style={[styles.chip, on && styles.chipOn]}
              accessibilityRole="button"
              accessibilityState={{ selected: on }}
            >
              <Text style={[styles.chipText, on && styles.chipTextOn]}>{option.label}</Text>
              {option.sub ? (
                <Text style={[styles.chipSub, on && styles.chipSubOn]} numberOfLines={1}>
                  {option.sub}
                </Text>
              ) : null}
            </Pressable>
          );
        })}
      </View>
      {/* Two sentences because the chip beside it may not be there: with no
          phone on file the WhatsApp chip is dropped, and a hint explaining a
          choice nobody was offered reads as a missing control. */}
      <Text style={styles.hint}>
        {phone
          ? 'In the app always works and keeps the record. Picking WhatsApp doesn’t change where the reply is written — it tells us to nudge you there too.'
          : 'We write back here, under Your messages. That keeps the whole conversation in one place.'}
      </Text>

      {problem && (
        <Caveat tone="wrong" action={{ label: 'Try again', onPress: () => void send() }}>
          {problem}
        </Caveat>
      )}

      {/* Context, not wrong: the report is on a thread and answerable. A
          'wrong' tone here would say the send failed, and the action that
          follows from that is to write it out again -- which is how one
          unattached screenshot turns into two identical threads. */}
      {missedFiles && (
        <Caveat tone="context" onDismiss={() => setMissedFiles(null)}>
          {missedFiles}
        </Caveat>
      )}

      <Pressable
        onPress={send}
        disabled={!complete || sending}
        style={[supportStyles.send, styles.send, (!complete || sending) && supportStyles.sendOff]}
        accessibilityRole="button"
      >
        <Text style={[supportStyles.sendText, styles.sendText, (!complete || sending) && supportStyles.sendTextOff]}>
          {sending ? 'Sending…' : 'Send'}
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  // Only what genuinely differs from support-styles.ts lives here: this
  // form's label sits further from the block above it than a reply's does.
  label: { marginTop: 18 },
  who: { flexDirection: 'row', gap: 12, backgroundColor: theme.bentoSoft, borderRadius: 16, padding: 13 },
  avatar: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: theme.bentoAccentWash,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: { fontSize: 12.5, fontWeight: '800', color: theme.bentoAccentInk },
  whoText: { flex: 1, minWidth: 0 },
  whoName: { fontSize: 13.5, fontWeight: '800', color: theme.bentoInk },
  whoLine: { fontSize: 11.5, color: theme.bentoMuted },
  auto: {
    fontSize: 10.5,
    color: theme.bentoMuted2,
    marginTop: 9,
    paddingTop: 9,
    borderTopWidth: 1,
    borderTopColor: theme.bentoRule,
  },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 7 },
  chip: {
    borderWidth: 1,
    borderColor: theme.bentoRule,
    borderRadius: 999,
    paddingVertical: 7,
    paddingHorizontal: 13,
  },
  chipOn: { backgroundColor: theme.bentoAccentWash, borderColor: 'transparent' },
  chipText: { fontSize: 12.5, fontWeight: '700', color: theme.bentoInk2 },
  chipTextOn: { color: theme.bentoAccentInk, fontWeight: '800' },
  // The number the nudge would actually go to. Shown rather than held in the
  // options list unseen: WhatsApp is a promise this line is the evidence for,
  // and a stale number on file is exactly the thing worth catching here.
  chipSub: { fontSize: 10.5, color: theme.bentoMuted2, marginTop: 1 },
  chipSubOn: { color: theme.bentoAccentInk },
  reveal: { borderLeftWidth: 2, borderLeftColor: theme.bentoAccentWash, paddingLeft: 11 },
  input: { paddingVertical: 11, paddingHorizontal: 13 },
  area: { minHeight: 96, textAlignVertical: 'top' },
  hint: { fontSize: 11, color: theme.bentoMuted2, marginTop: 6 },
  send: { marginTop: 20, paddingVertical: 13 },
  sendText: { fontSize: 13.5 },
});
