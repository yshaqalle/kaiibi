import Constants from 'expo-constants';
import { usePathname } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { AttachmentPicker } from '@/components/support/attachment-picker';
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
  type SupportThread,
} from '@/lib/support';
import { attachmentPath, uploadAttachment, type PendingAttachment } from '@/lib/support-attachments';
import { clearStoredDraft, readStoredDraft, writeStoredDraft } from '@/lib/support-draft';
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
  const [sending, setSending] = useState(false);

  // Opening a thread is not idempotent, so a send that got past createThread
  // and then failed on an attachment must resume rather than start over --
  // otherwise the 'Try again' button is a button that files a second copy of
  // the same report and leaves the first unanswerable.
  const openedThread = useRef<SupportThread | null>(null);

  // Restore once, then persist on every change. Nothing typed is lost to a
  // failed send, a closed sheet, or a killed app.
  const restored = useRef(false);

  useEffect(() => {
    void readStoredDraft().then((stored) => {
      restored.current = true;
      // Anything typed while the read was in flight wins: the restore is a
      // convenience, and overwriting live keystrokes with it is the one way
      // this feature could itself lose what someone wrote.
      if (stored) setDraft((current) => (current === EMPTY_DRAFT ? stored : current));
    });
  }, []);

  useEffect(() => {
    // Held until the restore has answered, so the empty first render cannot
    // erase the draft it is about to be replaced by.
    if (!restored.current) return;
    writeStoredDraft(draft);
  }, [draft]);

  useEffect(() => {
    // Editing after a part-finished send means the words have changed, and the
    // thread already opened carries the old ones -- so it is no longer the
    // thread this send is trying to finish, and resuming into it would drop
    // the edit silently.
    openedThread.current = null;
  }, [draft]);

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

  const send = async () => {
    const validation = validateDraft(draft);
    if (!validation.ok) {
      setProblem(validation.message);
      return;
    }
    if (!shop || !session) return;

    setSending(true);
    setProblem(null);
    try {
      // No author argument: the RPC behind this reads auth.uid() itself.
      const thread = openedThread.current ?? (await createThread(shop.id, draft, context));
      openedThread.current = thread;

      if (files.length > 0) {
        // The RPC returns the thread row and nothing else, so the id of the
        // message it wrote alongside it still has to be asked for -- an
        // attachment hangs off a message, not off a thread. The thread is
        // seconds old, so the oldest message is the one just written.
        const { data: message, error } = await supabase
          .from('support_messages')
          .select('id')
          .eq('thread_id', thread.id)
          .order('created_at', { ascending: true })
          .limit(1)
          .single();
        if (error) throw error;

        for (const file of files) {
          const path = attachmentPath(shop.id, thread.id, file.fileName, Date.now());
          await uploadAttachment(path, file);
          const { error: linkError } = await supabase.from('support_attachments').insert({
            message_id: message.id,
            storage_path: path,
            file_name: file.fileName,
            byte_size: file.byteSize,
            content_type: file.contentType,
          });
          if (linkError) throw linkError;
        }
      }

      clearStoredDraft();
      openedThread.current = null;
      setDraft(EMPTY_DRAFT);
      setFiles([]);
      onSent(thread.reference);
    } catch (error) {
      // The draft is deliberately left alone. Nothing typed is ever lost to a
      // failed send -- retyping a bug report is how people stop reporting bugs.
      setProblem(error instanceof Error ? error.message : 'That did not send. Try again in a moment.');
    } finally {
      setSending(false);
    }
  };

  const complete = validateDraft(draft).ok;

  return (
    <View>
      <Text style={styles.label}>Sent as</Text>
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

      <Text style={styles.label}>What&apos;s this about?</Text>
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
          <Text style={styles.label}>{meta.areaLabel}</Text>
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
          <Text style={styles.label}>Then what is it about?</Text>
          <TextInput
            value={draft.areaOther}
            onChangeText={(areaOther) => setDraft((d) => ({ ...d, areaOther }))}
            placeholder="A few words"
            placeholderTextColor={theme.bentoMuted2}
            style={styles.input}
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

      <Text style={styles.label}>Subject</Text>
      <TextInput
        value={draft.subject}
        onChangeText={(subject) => setDraft((d) => ({ ...d, subject }))}
        placeholder="A short line — &quot;Scanner stops after a refund&quot;"
        placeholderTextColor={theme.bentoMuted2}
        style={styles.input}
      />

      <Text style={styles.label}>{meta?.detailsLabel ?? 'Details'}</Text>
      <TextInput
        value={draft.details}
        onChangeText={(details) => setDraft((d) => ({ ...d, details }))}
        placeholder={meta ? '' : 'Pick a category above and we will tell you what is most useful to include.'}
        placeholderTextColor={theme.bentoMuted2}
        multiline
        style={[styles.input, styles.area]}
      />
      {meta && <Text style={styles.hint}>{meta.detailsHint}</Text>}

      <Text style={styles.label}>Attachments — optional</Text>
      <AttachmentPicker files={files} onChange={setFiles} />

      <Text style={styles.label}>Reply to me on</Text>
      <View style={styles.chips}>
        {(
          [
            { key: 'in_app', label: 'In the app', sub: 'here, under Your messages' },
            ...(phone ? [{ key: 'whatsapp' as const, label: 'WhatsApp', sub: phone }] : []),
            { key: 'email', label: 'Email', sub: email ?? '' },
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
      <Text style={styles.hint}>
        In the app always works and keeps the record. Picking WhatsApp doesn&apos;t change where the reply is
        written — it tells us to nudge you there too.
      </Text>

      {problem && (
        <Caveat tone="wrong" action={{ label: 'Try again', onPress: () => void send() }}>
          {problem}
        </Caveat>
      )}

      <Pressable
        onPress={send}
        disabled={!complete || sending}
        style={[styles.send, (!complete || sending) && styles.sendOff]}
        accessibilityRole="button"
      >
        <Text style={[styles.sendText, (!complete || sending) && styles.sendTextOff]}>
          {sending ? 'Sending…' : 'Send'}
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  label: {
    fontSize: 9.5,
    fontWeight: '800',
    letterSpacing: 1,
    textTransform: 'uppercase',
    color: theme.bentoMuted2,
    marginTop: 18,
    marginBottom: 8,
  },
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
  // The address the reply would actually go to. Shown rather than held in the
  // options list unseen: "Email" is a promise this line is the evidence for,
  // and a stale address on file is exactly the thing worth catching here.
  chipSub: { fontSize: 10.5, color: theme.bentoMuted2, marginTop: 1 },
  chipSubOn: { color: theme.bentoAccentInk },
  reveal: { borderLeftWidth: 2, borderLeftColor: theme.bentoAccentWash, paddingLeft: 11 },
  input: {
    borderWidth: 1,
    borderColor: theme.bentoRule,
    borderRadius: 12,
    paddingVertical: 11,
    paddingHorizontal: 13,
    fontSize: 13.5,
    color: theme.bentoInk,
  },
  area: { minHeight: 96, textAlignVertical: 'top' },
  hint: { fontSize: 11, color: theme.bentoMuted2, marginTop: 6 },
  send: {
    marginTop: 20,
    backgroundColor: theme.bentoInk,
    borderRadius: 999,
    paddingVertical: 13,
    alignItems: 'center',
  },
  sendOff: { backgroundColor: theme.bentoSoft },
  sendText: { fontSize: 13.5, fontWeight: '800', color: theme.bentoSurface },
  sendTextOff: { color: theme.bentoMuted2 },
});
