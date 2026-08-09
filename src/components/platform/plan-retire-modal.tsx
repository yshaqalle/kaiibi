import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { ActionRow, Chip, Field, PlatformButton, SectionLabel } from '@/components/platform/kit';
import { Caveat } from '@/components/ui/caveat';
import { Colors } from '@/constants/theme';
import { callPlatformAdmin } from '@/lib/platform';
import type { Plan } from '@/lib/subscriptions';

// Pinned to the light palette for now — no dark-mode switching yet.
const theme = Colors.light;

// Withdrawing a tier from sale. Hidden from the chooser at once; the stores on
// it keep everything for 30 days and are told where they are going; on the date
// shop_effective_plan() resolves them to the successor. Nothing is bulk-updated,
// so republishing before the date undoes all of it.
export function PlanRetireModal({
  plan,
  plans,
  shopsOn,
  pendingRequests,
  postTrialPlanKey,
  onClose,
  onDone,
}: {
  plan: Plan;
  plans: Plan[];
  shopsOn: number;
  pendingRequests: number;
  postTrialPlanKey: string;
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  // A plan can only receive stores if it is offered, staying, and active.
  // `trial` fails the first test — it is assigned by the signup trigger and
  // never chosen, so it can never be a destination either.
  const candidates = plans.filter((p) => p.key !== plan.key && p.isPublic && !p.retireAt);
  const [successor, setSuccessor] = useState<string | null>(candidates[0]?.key ?? null);
  // Starts unset, deliberately, unlike successor above. Seeding this from
  // candidates[0] would mean an operator retiring the fallback plan and
  // accepting defaults silently moves every lapsed store on the platform onto
  // whatever plan happens to sort first -- immediately, with no 30-day window
  // and no way to undo it from this sheet. A blank Chip row forces the
  // deliberate pick this guard exists to require.
  const [fallback, setFallback] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const republishing = plan.retireAt != null;
  // Free is reached by falling THROUGH this setting, not by being on it, so
  // retiring the fallback without naming a new one hands every lapsed store the
  // successor's entitlements for nothing.
  const isFallback = postTrialPlanKey === plan.key;
  const successorName = plans.find((p) => p.key === successor)?.name ?? '';

  const run = async () => {
    if (!reason.trim()) {
      setError('A reason is required for every change.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (republishing) {
        await callPlatformAdmin('republish_plan', { planKey: plan.key }, reason.trim());
      } else {
        await callPlatformAdmin(
          'retire_plan',
          {
            planKey: plan.key,
            successorPlanKey: successor,
            ...(isFallback ? { postTrialPlanKey: fallback } : {}),
          },
          reason.trim()
        );
      }
      await onDone();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not change that plan.');
    } finally {
      setBusy(false);
    }
  };

  if (republishing) {
    return (
      <View>
        <Text style={styles.meta}>
          key `{plan.key}` — {shopsOn} store{shopsOn === 1 ? '' : 's'} on it
        </Text>
        <View style={styles.caveat}>
          <Caveat tone="context">
            {`Putting ${plan.name} back on sale. This only restores it as a choice — no store's subscription was ever moved, so anyone still on it simply keeps reading its entitlements. Where lapsed stores land is a separate setting and is not restored by this; check it in the Settings tab if you changed it when retiring.`}
          </Caveat>
        </View>

        <SectionLabel>Reason</SectionLabel>
        <Field
          value={reason}
          onChangeText={setReason}
          placeholder="Reason (required — goes into the audit log)"
          needed={!reason.trim()}
        />
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <ActionRow style={styles.footer}>
          <PlatformButton label={busy ? 'Saving…' : 'Republish plan'} disabled={busy || !reason.trim()} onPress={run} />
          <Pressable onPress={onClose}>
            <Text style={styles.cancel}>Cancel</Text>
          </Pressable>
        </ActionRow>
      </View>
    );
  }

  return (
    <View>
      <Text style={styles.meta}>
        key `{plan.key}` — {shopsOn} store{shopsOn === 1 ? '' : 's'} depend on it
        {pendingRequests > 0 ? `, ${pendingRequests} pending request${pendingRequests === 1 ? '' : 's'}` : ''}
      </Text>

      <SectionLabel>Move them to</SectionLabel>
      {candidates.length === 0 ? (
        <Text style={styles.meta}>
          No other plan is public and staying, so there is nowhere to move these stores yet. Publish or un-retire
          another plan first.
        </Text>
      ) : (
        <ActionRow>
          {candidates.map((p) => (
            <Chip
              key={p.key}
              label={p.priceCents === 0 ? p.name : `${p.name} · ${(p.priceCents / 100).toFixed(0)}/${p.billingInterval ?? 'month'}`}
              active={successor === p.key}
              onPress={() => setSuccessor(p.key)}
            />
          ))}
        </ActionRow>
      )}

      {isFallback ? (
        <>
          <SectionLabel>New home for lapsed stores</SectionLabel>
          <ActionRow>
            {candidates.map((p) => (
              <Chip key={p.key} label={p.name} active={fallback === p.key} onPress={() => setFallback(p.key)} />
            ))}
          </ActionRow>
          <View style={styles.caveat}>
            <Caveat tone="wrong" action={{ label: 'Cancel this', onPress: onClose }}>
              {`${plan.name} is where lapsed stores land, and they get there by falling through the setting rather than by being on the plan — so the 30-day grace below does not cover them. The moment you confirm, every lapsed and suspended store on the platform moves to whichever plan you pick above. Retiring is blocked until you pick one.`}
            </Caveat>
          </View>
        </>
      ) : null}

      {pendingRequests > 0 ? (
        <View style={styles.caveat}>
          <Caveat tone="wrong" action={{ label: 'Cancel this', onPress: onClose }}>
            {`${pendingRequests} store${pendingRequests === 1 ? ' has' : 's have'} asked to move onto ${plan.name}. Those requests can no longer be approved once it is retiring — decline them${
              // successorName is '' when there are no candidates at all (see
              // the empty-candidates message above) -- without this guard the
              // sentence ends "...move those stores to  instead."
              successorName ? ` and move those stores to ${successorName} instead.` : '.'
            }`}
          </Caveat>
        </View>
      ) : null}

      <View style={styles.caveat}>
        <Caveat tone="context">
          {`Hidden from the plan picker straight away. Nothing changes for the ${shopsOn} store${
            shopsOn === 1 ? '' : 's'
          } on it for 30 days — they keep everything, and you can move any of them sooner from Stores. Republishing before then undoes all of it.`}
        </Caveat>
      </View>

      <SectionLabel>Reason</SectionLabel>
      <Field
        value={reason}
        onChangeText={setReason}
        placeholder="Reason (required — goes into the audit log)"
        needed={!reason.trim()}
      />
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <ActionRow style={styles.footer}>
        <PlatformButton
          label={busy ? 'Saving…' : 'Retire plan'}
          disabled={busy || !reason.trim() || !successor || (isFallback && !fallback)}
          danger
          onPress={run}
        />
        <Pressable onPress={onClose}>
          <Text style={styles.cancel}>Cancel</Text>
        </Pressable>
      </ActionRow>
    </View>
  );
}

const styles = StyleSheet.create({
  meta: { fontSize: 11, color: theme.bentoMuted, marginBottom: 4 },
  caveat: { marginTop: 14 },
  error: { color: theme.bentoLoss, fontSize: 12, fontWeight: '700', marginTop: 8 },
  footer: { marginTop: 14 },
  cancel: { color: theme.bentoMuted, fontSize: 12, fontWeight: '700', paddingHorizontal: 8 },
});
