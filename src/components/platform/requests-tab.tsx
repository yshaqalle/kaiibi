import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { ActionRow, Field, PlatformButton } from '@/components/platform/kit';
import { BentoCard } from '@/components/ui/bento-card';
import { Caveat } from '@/components/ui/caveat';
import { Colors } from '@/constants/theme';
import { callPlatformAdmin, type PendingPlanRequest, type PlatformShopRow } from '@/lib/platform';

// Pinned to the light palette for now — no dark-mode switching yet.
const theme = Colors.light;

// The approval queue. A shop cannot move itself between tiers — payment is
// ZAAD/eDahab confirmed by hand, so this is where a tier gets tied to money
// actually arriving.
//
// One card, read down. The shared reason field lives at its head so it is
// visibly a precondition for the buttons below rather than something you
// discover by failing.
export function RequestsTab({
  requests,
  shops,
  onDone,
}: {
  requests: PendingPlanRequest[];
  shops: PlatformShopRow[];
  onDone: () => Promise<void>;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const decide = async (requestId: string, approve: boolean) => {
    // Kept as a guard even though the buttons are disabled without a reason:
    // the server requires one too, and a client-side disable is a courtesy,
    // not a rule.
    if (!reason.trim()) {
      setError('A reason is required — it is what the store sees if you decline.');
      return;
    }
    setBusy(requestId);
    setError(null);
    try {
      await callPlatformAdmin(approve ? 'approve_plan_change' : 'decline_plan_change', { requestId }, reason.trim());
      setReason('');
      await onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That decision did not go through.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <BentoCard
      title="Waiting on you"
      scope={requests.length === 1 ? '1 request' : `${requests.length} requests`}
    >
      {requests.length === 0 ? (
        <Text style={styles.empty}>Nothing waiting.</Text>
      ) : (
        <>
          <Field
            value={reason}
            onChangeText={setReason}
            placeholder="Reason (required — a decline shows this to the store)"
            needed={!reason.trim()}
          />
          {!reason.trim() ? (
            <View style={styles.caveat}>
              <Caveat tone="wrong">
                Type a reason to enable Approve and Decline. If you decline, this is the message the store reads.
              </Caveat>
            </View>
          ) : null}

          {requests.map((request, i) => {
            const shop = shops.find((s) => s.shopId === request.shopId);
            return (
              <View key={request.id} style={[styles.request, i === 0 && styles.requestFirst]}>
                <View style={styles.head}>
                  <Text style={styles.shopName} numberOfLines={1}>
                    {shop?.shopName ?? request.shopId.slice(0, 8)}
                  </Text>
                  <Text style={styles.move}>
                    {shop?.planName ?? '—'} → <Text style={styles.moveTarget}>{request.planName}</Text>
                  </Text>
                </View>
                <Text style={styles.meta}>
                  asked {request.createdAt.slice(0, 10)}
                  {request.note ? ` · “${request.note}”` : ''}
                </Text>
                <ActionRow style={styles.actions}>
                  <PlatformButton
                    label="Approve"
                    disabled={busy !== null || !reason.trim()}
                    onPress={() => decide(request.id, true)}
                  />
                  <PlatformButton
                    label="Decline"
                    danger
                    disabled={busy !== null || !reason.trim()}
                    onPress={() => decide(request.id, false)}
                  />
                </ActionRow>
              </View>
            );
          })}
        </>
      )}

      {error ? <Text style={styles.error}>{error}</Text> : null}

      <Caveat tone="context">
        A store can raise and cancel its own request but can never resolve one — there is no update policy on the table
        at all, and both decisions run through the audited platform-admin function.
      </Caveat>
    </BentoCard>
  );
}

const styles = StyleSheet.create({
  caveat: { marginTop: 10 },
  request: { paddingVertical: 14, borderTopWidth: 1, borderTopColor: theme.bentoRule },
  requestFirst: { marginTop: 14 },
  head: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' },
  shopName: { fontSize: 14, fontWeight: '800', color: theme.bentoInk, flexShrink: 1 },
  move: { fontSize: 12.5, color: theme.bentoMuted },
  moveTarget: { color: theme.bentoInk, fontWeight: '800' },
  meta: { fontSize: 11.5, color: theme.bentoMuted, marginTop: 4 },
  actions: { marginTop: 10 },
  error: { color: theme.bentoLoss, fontSize: 12, fontWeight: '700', marginTop: 10 },
  empty: { fontSize: 13, color: theme.bentoMuted },
});
