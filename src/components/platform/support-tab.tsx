import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Chip } from '@/components/platform/kit';
import { BentoCard } from '@/components/ui/bento-card';
import { Caveat } from '@/components/ui/caveat';
import { Colors } from '@/constants/theme';
import { supportQueueState, type PlatformShopRow, type PlatformSupportThread } from '@/lib/platform';
import { SUPPORT_CATEGORIES } from '@/lib/support-taxonomy';

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
  onOpen,
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
  onOpen: (thread: PlatformSupportThread) => void;
  onCompose: () => void;
}) {
  const [filter, setFilter] = useState<string | null>(null);

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
              <Pressable key={thread.id} onPress={() => onOpen(thread)} style={styles.row}>
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
      </BentoCard>
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
