import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { ActionRow, Chip, Field, LabelledField, PlatformButton, SectionLabel } from '@/components/platform/kit';
import { limitLabel } from '@/components/platform/labels';
import { Caveat } from '@/components/ui/caveat';
import { Colors } from '@/constants/theme';
import { LIMIT_RESOURCES, MODULES } from '@/lib/entitlements';
import { callPlatformAdmin, type PlatformShopRow } from '@/lib/platform';
import type { Plan } from '@/lib/subscriptions';

// Pinned to the light palette for now — no dark-mode switching yet.
const theme = Colors.light;

// Editing a plan changes entitlements for every shop on it at once, with no
// further confirmation anywhere — which is why the blast radius is computed and
// shown before saving rather than described in the abstract.
export function PlanEditor({
  plan,
  shopsOn,
  shops,
  onClose,
  onDone,
}: {
  plan: Plan;
  shopsOn: number;
  shops: PlatformShopRow[];
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const [name, setName] = useState(plan.name);
  const [price, setPrice] = useState(String(plan.priceCents / 100));
  const [modules, setModules] = useState<string[]>(plan.modules);
  // Kept as raw text, blank meaning unlimited, so an operator clearing a field
  // says "no cap" rather than being forced to invent a number.
  const [limits, setLimits] = useState<Record<string, string>>(
    Object.fromEntries(LIMIT_RESOURCES.map((r) => [r.key, plan.limits[r.key] == null ? '' : String(plan.limits[r.key])]))
  );
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = (key: string) =>
    setModules((current) => (current.includes(key) ? current.filter((m) => m !== key) : [...current, key]));

  // Who this edit actually hurts, right now, by name.
  const losingModules = plan.modules.filter((m) => !modules.includes(m));
  const strandedByLimit = LIMIT_RESOURCES.flatMap((r) => {
    const raw = limits[r.key].trim();
    if (raw === '') return [];
    const next = Number(raw);
    if (!Number.isFinite(next)) return [];
    const over = shops.filter((s) => s.planKey === plan.key && (s.usage[r.key] ?? 0) > next);
    return over.length > 0 ? [`${over.length} over ${limitLabel(r.key).toLowerCase()}`] : [];
  });

  const save = async () => {
    if (!reason.trim()) {
      setError('A reason is required for every change.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await callPlatformAdmin(
        'upsert_plan',
        {
          plan: {
            key: plan.key,
            name: name.trim(),
            price_cents: Math.round((Number(price) || 0) * 100),
            modules,
            limits: Object.fromEntries(
              LIMIT_RESOURCES.map((r) => [r.key, limits[r.key].trim() === '' ? null : Number(limits[r.key])]).filter(
                ([, v]) => v !== null
              )
            ),
          },
        },
        reason.trim()
      );
      await onDone();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save that plan.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <View>
      <View style={styles.headRow}>
        <LabelledField label="Name">
          <Field value={name} onChangeText={setName} style={styles.nameField} />
        </LabelledField>
        <LabelledField label={`Price (${plan.currency})`}>
          <Field value={price} onChangeText={setPrice} keyboardType="decimal-pad" width={112} />
        </LabelledField>
      </View>
      <Text style={styles.meta}>
        key `{plan.key}` — not editable, {shopsOn} store{shopsOn === 1 ? '' : 's'} depend on it
      </Text>

      <SectionLabel>Modules</SectionLabel>
      <ActionRow>
        {MODULES.map((m) => (
          <Chip key={m.key} label={m.label} active={modules.includes(m.key)} onPress={() => toggle(m.key)} />
        ))}
      </ActionRow>

      <SectionLabel>Limits — blank means unlimited</SectionLabel>
      <ActionRow>
        {LIMIT_RESOURCES.map((r) => (
          <LabelledField key={r.key} label={limitLabel(r.key)}>
            <Field
              value={limits[r.key]}
              onChangeText={(v) => setLimits((c) => ({ ...c, [r.key]: v }))}
              keyboardType="number-pad"
              placeholder="∞"
              width={92}
            />
          </LabelledField>
        ))}
      </ActionRow>

      {(losingModules.length > 0 || strandedByLimit.length > 0) && shopsOn > 0 ? (
        <View style={styles.caveat}>
          <Caveat tone="wrong" action={{ label: 'Cancel this edit', onPress: onClose }}>
            {`This affects ${shopsOn} store${shopsOn === 1 ? '' : 's'} immediately.${
              losingModules.length > 0
                ? ` Removing ${losingModules.join(', ')} makes that data read-only for them at once.`
                : ''
            }${
              strandedByLimit.length > 0
                ? ` Lowering caps strands ${strandedByLimit.join(', ')} — existing records are kept, new ones blocked.`
                : ''
            }`}
          </Caveat>
        </View>
      ) : null}

      <SectionLabel>Reason</SectionLabel>
      <Field
        value={reason}
        onChangeText={setReason}
        placeholder="Reason (required — goes into the audit log)"
        needed={!reason.trim()}
      />
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <ActionRow style={styles.footer}>
        <PlatformButton label={busy ? 'Saving…' : 'Save plan'} disabled={busy || !reason.trim()} onPress={save} />
        <Pressable onPress={onClose}>
          <Text style={styles.cancel}>Cancel</Text>
        </Pressable>
      </ActionRow>
    </View>
  );
}

const styles = StyleSheet.create({
  headRow: { flexDirection: 'row', gap: 12, flexWrap: 'wrap' },
  nameField: { minWidth: 200 },
  meta: { fontSize: 11, color: theme.bentoMuted, marginTop: 8 },
  caveat: { marginTop: 14 },
  error: { color: theme.bentoLoss, fontSize: 12, fontWeight: '700', marginTop: 8 },
  footer: { marginTop: 14 },
  cancel: { color: theme.bentoMuted, fontSize: 12, fontWeight: '700', paddingHorizontal: 8 },
});
