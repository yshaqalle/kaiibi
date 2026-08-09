import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { ActionRow, Chip, Field, LabelledField, PlatformButton, SectionLabel } from '@/components/platform/kit';
import { BentoCard } from '@/components/ui/bento-card';
import { Caveat } from '@/components/ui/caveat';
import { Colors } from '@/constants/theme';
import { callPlatformAdmin, type PlatformSettings } from '@/lib/platform';
import type { Plan } from '@/lib/subscriptions';

// Pinned to the light palette for now — no dark-mode switching yet.
const theme = Colors.light;

// The singleton row, editable. Three columns exist on `platform_settings` and
// this offers exactly those three — nothing invented.
//
// `postTrialPlanKey` is the one that matters most: an expired or suspended
// store reaches its entitlements by falling THROUGH this setting, never by
// being ON a plan, so retiring the plan named here (retire_plan's own guard)
// is otherwise a write with no product surface to correct from. This tab is
// that surface.
export function SettingsTab({
  settings,
  plans,
  onDone,
}: {
  settings: PlatformSettings;
  plans: Plan[];
  onDone: () => Promise<void>;
}) {
  const [trialDays, setTrialDays] = useState(String(settings.defaultTrialDays));
  const [graceDays, setGraceDays] = useState(String(settings.defaultGraceDays));
  const [fallback, setFallback] = useState(settings.postTrialPlanKey);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Exactly the guard set_platform_settings itself enforces (platform-admin/
  // index.ts): must be public and not retiring (the server also requires
  // `active`, which every plan is by default and nothing in this app ever
  // clears — the same gap plan-retire-modal's own candidate list lives with).
  // Offering a choice the server will reject would just move the failure from
  // this picker to the error banner below.
  const eligible = plans.filter((p) => p.isPublic && !p.retireAt);
  const currentPlan = plans.find((p) => p.key === settings.postTrialPlanKey);
  // The saved fallback might have since retired without this tab being
  // revisited. Shown anyway, alongside the eligible list, so the picker never
  // silently hides what a lapsed store is actually reading right now.
  const choices = !currentPlan || eligible.some((p) => p.key === currentPlan.key) ? eligible : [currentPlan, ...eligible];
  const fallbackName = plans.find((p) => p.key === fallback)?.name ?? fallback;

  const trialValid = Number.isFinite(Number(trialDays)) && Number(trialDays) >= 0;
  const graceValid = Number.isFinite(Number(graceDays)) && Number(graceDays) >= 0;
  const changed =
    trialDays !== String(settings.defaultTrialDays) ||
    graceDays !== String(settings.defaultGraceDays) ||
    fallback !== settings.postTrialPlanKey;

  const save = async () => {
    if (!reason.trim()) {
      setError('A reason is required for every change.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await callPlatformAdmin(
        'set_platform_settings',
        {
          settings: {
            default_trial_days: Math.round(Number(trialDays)),
            default_grace_days: Math.round(Number(graceDays)),
            post_trial_plan_key: fallback,
          },
        },
        reason.trim()
      );
      setReason('');
      await onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save platform settings.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <BentoCard title="Platform defaults" scope={`Fallback: ${currentPlan?.name ?? settings.postTrialPlanKey}`}>
      <SectionLabel>New signups</SectionLabel>
      <ActionRow>
        <LabelledField label="Trial length (days)">
          <Field value={trialDays} onChangeText={setTrialDays} keyboardType="number-pad" width={100} needed={!trialValid} />
        </LabelledField>
        <LabelledField label="Grace period (days)">
          <Field value={graceDays} onChangeText={setGraceDays} keyboardType="number-pad" width={100} needed={!graceValid} />
        </LabelledField>
      </ActionRow>
      <Text style={styles.meta}>
        Applied when a shop signs up or lapses. Changing these does not reach back and rewrite a trial or grace window
        already running.
      </Text>

      <SectionLabel>Where lapsed stores land</SectionLabel>
      {choices.length === 0 ? (
        <Text style={styles.meta}>No plan is both public and staying, so there is nothing to pick from yet.</Text>
      ) : (
        <ActionRow>
          {choices.map((p) => (
            <Chip key={p.key} label={p.name} active={fallback === p.key} onPress={() => setFallback(p.key)} />
          ))}
        </ActionRow>
      )}

      <View style={styles.caveat}>
        <Caveat
          tone="wrong"
          action={{
            label: `Reset to ${currentPlan?.name ?? settings.postTrialPlanKey}`,
            onPress: () => setFallback(settings.postTrialPlanKey),
          }}
        >
          {`${fallbackName} is where every expired or suspended store on the platform reaches its entitlements -- they get there by falling through this setting, not by being on a plan, so none of the 30-day grace a plan retirement gives applies here. The moment you save, every expired and suspended store on the platform moves to whichever plan is selected above, immediately.`}
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
          label={busy ? 'Saving…' : 'Save settings'}
          disabled={busy || !reason.trim() || !changed || !trialValid || !graceValid}
          danger={fallback !== settings.postTrialPlanKey}
          onPress={save}
        />
      </ActionRow>
    </BentoCard>
  );
}

const styles = StyleSheet.create({
  meta: { fontSize: 11, color: theme.bentoMuted, marginTop: 8 },
  caveat: { marginTop: 14 },
  error: { color: theme.bentoLoss, fontSize: 12, fontWeight: '700', marginTop: 8 },
  footer: { marginTop: 14 },
});
