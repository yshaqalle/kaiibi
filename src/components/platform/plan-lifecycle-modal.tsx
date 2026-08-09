import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { ActionRow, Field, PlatformButton, SectionLabel } from '@/components/platform/kit';
import { Colors } from '@/constants/theme';
import { formatCents } from '@/lib/currency';
import { callPlatformAdmin } from '@/lib/platform';
import type { Plan } from '@/lib/subscriptions';

// Pinned to the light palette for now — no dark-mode switching yet.
const theme = Colors.light;

// One sheet for the three one-way-ish plan switches. They share everything
// but their copy: a single audited action keyed by plan, a mandatory reason,
// and no other input. The caller only renders this when the matching
// can*Plan() predicate passed, so the sheet states consequences rather than
// re-litigating eligibility — except archive, whose checklist is shown ticked
// because "safe because" is the whole reassurance that sheet exists to give.
const ACTIONS = {
  publish: { action: 'publish_plan', button: 'Publish', danger: false },
  archive: { action: 'archive_plan', button: 'Archive plan', danger: true },
  restore: { action: 'restore_plan', button: 'Restore', danger: false },
} as const;

const ARCHIVE_CHECKS = [
  '0 subscriptions still point at it',
  'Not the post-trial fallback plan',
  'No retiring plan names it as successor',
];

export function PlanLifecycleModal({
  mode,
  plan,
  onClose,
  onDone,
}: {
  mode: keyof typeof ACTIONS;
  plan: Plan;
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    if (!reason.trim()) {
      setError('A reason is required for every change.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await callPlatformAdmin(ACTIONS[mode].action, { planKey: plan.key }, reason.trim());
      await onDone();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update that plan.');
    } finally {
      setBusy(false);
    }
  };

  const price = plan.priceCents === 0 ? 'free' : `${formatCents(plan.priceCents)}/${plan.billingInterval ?? 'month'}`;
  const limitCount = Object.values(plan.limits).filter((v) => v != null).length;

  return (
    <View>
      {mode === 'publish' ? (
        <Text style={styles.copy}>
          Appears in every store&apos;s plan picker immediately — {price}, with the {plan.modules.length} module
          {plan.modules.length === 1 ? '' : 's'} and {limitCount} limit{limitCount === 1 ? '' : 's'} it has right now.
        </Text>
      ) : mode === 'archive' ? (
        <>
          <Text style={styles.copy}>
            Puts the plan away. It leaves this tab for the Archived list below the grid — nothing is deleted, and
            Restore brings it back exactly as it is now.
          </Text>
          <SectionLabel>Safe to archive</SectionLabel>
          {ARCHIVE_CHECKS.map((check) => (
            <View key={check} style={styles.check}>
              <Text style={styles.checkGlyph}>✓</Text>
              <Text style={styles.checkText}>{check}</Text>
            </View>
          ))}
        </>
      ) : (
        <Text style={styles.copy}>
          Comes back to the grid exactly as it went away — hidden{plan.retireAt ? ' and retired' : ''} — so no
          store&apos;s plan picker changes.
        </Text>
      )}

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
          label={busy ? 'Working…' : ACTIONS[mode].button}
          danger={ACTIONS[mode].danger}
          disabled={busy || !reason.trim()}
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
  copy: { fontSize: 12.5, lineHeight: 18, color: theme.bentoInk2 },
  check: { flexDirection: 'row', alignItems: 'baseline', gap: 9, marginBottom: 7 },
  // bentoProfit is a status colour and must never stand alone — the ✓ glyph is
  // the signal; the green only underlines it.
  checkGlyph: { fontSize: 12, fontWeight: '800', color: theme.bentoProfit },
  checkText: { fontSize: 12, color: theme.bentoInk2 },
  error: { color: theme.bentoLoss, fontSize: 12, fontWeight: '700', marginTop: 8 },
  footer: { marginTop: 14 },
  cancel: { color: theme.bentoMuted, fontSize: 12, fontWeight: '700', paddingHorizontal: 8 },
});
