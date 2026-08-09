import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { ActionRow, Chip, Field, LabelledField, PlatformButton, SectionLabel } from '@/components/platform/kit';
import { limitLabel } from '@/components/platform/labels';
import { Caveat } from '@/components/ui/caveat';
import { SubscriptionStatusPill } from '@/components/ui/subscription-status';
import { Colors } from '@/constants/theme';
import { periodMonths } from '@/lib/billing-period';
import { LIMIT_RESOURCES, MODULES } from '@/lib/entitlements';
import { callPlatformAdmin, type PlatformShopRow } from '@/lib/platform';
import type { Plan } from '@/lib/subscriptions';

// Pinned to the light palette for now — no dark-mode switching yet.
const theme = Colors.light;

// Everything an operator can do to one shop.
//
// Two things deliberately keep their colour rather than being flattened into
// the calm palette: the reason field, which gates every button below it and
// stays amber while empty, and the danger zone.

export function ShopDrawer({
  shop,
  plans,
  onDone,
}: {
  shop: PlatformShopRow;
  plans: Plan[];
  onDone: () => Promise<void>;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Seeded from the STORED key, not the effective one. Past a retirement date
  // the two are equal for nobody-has-touched-it stores and the button below
  // would be permanently disabled -- with no way left in the UI to commit
  // set_plan and bring shop_subscriptions.plan_id in line with the plan the
  // store is actually being enforced under.
  const [planKey, setPlanKey] = useState(shop.storedPlanKey);
  const [days, setDays] = useState('14');

  const run = async (action: string, payload: Record<string, unknown>) => {
    if (!reason.trim()) {
      setError('A reason is required for every change.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await callPlatformAdmin(action, { shopId: shop.shopId, ...payload }, reason.trim());
      setReason('');
      await onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That change did not go through.');
    } finally {
      setBusy(false);
    }
  };

  // What a downgrade would actually cost this shop, computed before it is
  // applied. The difference between an informed support action and an angry
  // phone call.
  const target = plans.find((p) => p.key === planKey);
  const wouldExceed = target
    ? LIMIT_RESOURCES.filter((r) => {
        const limit = target.limits[r.key];
        return limit != null && (shop.usage[r.key] ?? 0) > limit;
      })
    : [];

  const planModules = plans.find((p) => p.key === shop.planKey)?.modules ?? [];

  return (
    <View>
      <View style={styles.statusRow}>
        <SubscriptionStatusPill status={shop.status} />
        <Text style={styles.meta}>
          created {shop.createdAt.slice(0, 10)} · {shop.planName}
        </Text>
      </View>

      <SectionLabel>Usage</SectionLabel>
      {LIMIT_RESOURCES.map((r) => {
        const limit = shop.limits[r.key] ?? null;
        const used = shop.usage[r.key] ?? 0;
        const atLimit = limit != null && used >= limit;
        return (
          <View key={r.key} style={styles.usageRow}>
            <Text style={styles.usageLabel}>{limitLabel(r.key)}</Text>
            <Text style={[styles.usageValue, atLimit && styles.usageValueAtLimit]}>
              {used.toLocaleString()} / {limit == null ? '∞' : limit.toLocaleString()}
            </Text>
          </View>
        );
      })}

      <SectionLabel>{`Modules on ${shop.planName}`}</SectionLabel>
      <View style={styles.modules}>
        {MODULES.map((m) => {
          const on = planModules.includes(m.key);
          return (
            <View key={m.key} style={styles.modulePill}>
              <Text style={[styles.moduleText, !on && styles.moduleTextOff]}>
                {on ? '' : '✕ '}
                {m.label}
              </Text>
            </View>
          );
        })}
      </View>

      <SectionLabel>Actions</SectionLabel>
      <Field
        value={reason}
        onChangeText={setReason}
        placeholder="Reason (required — goes into the audit log)"
        needed={!reason.trim()}
      />
      {/* Says what's missing before the click rather than after it. The buttons
          below are disabled until this is filled, so the requirement is visible
          rather than discovered by failing. */}
      {!reason.trim() ? (
        <View style={styles.caveat}>
          <Caveat tone="wrong">
            Type a reason to enable these actions. Every change here is recorded against your operator account.
          </Caveat>
        </View>
      ) : null}

      <ActionRow style={styles.row}>
        {plans
          .filter((p) => p.isPublic)
          .map((p) => (
            <Chip key={p.key} label={p.name} active={planKey === p.key} onPress={() => setPlanKey(p.key)} />
          ))}
      </ActionRow>

      {wouldExceed.length > 0 ? (
        <View style={styles.caveat}>
          <Caveat tone="wrong">
            {`${target?.name} would put this store over ${wouldExceed.length} limit${
              wouldExceed.length === 1 ? '' : 's'
            }: ${wouldExceed
              .map((r) => `${limitLabel(r.key).toLowerCase()} ${shop.usage[r.key] ?? 0}/${target!.limits[r.key]}`)
              .join(', ')}. Existing data is kept and stays editable; new records are blocked until they are back under.`}
          </Caveat>
        </View>
      ) : null}

      <ActionRow style={styles.row}>
        <PlatformButton
          label="Change plan"
          disabled={busy || !reason.trim() || planKey === shop.storedPlanKey}
          onPress={() => run('set_plan', { planKey })}
        />
        <View style={styles.inlineDays}>
          <Field value={days} onChangeText={setDays} keyboardType="number-pad" width={58} style={styles.daysField} />
          <PlatformButton
            label="Extend trial"
            disabled={busy || !reason.trim()}
            onPress={() => run('extend_trial', { days: Number(days) || 0 })}
          />
        </View>
        {shop.manualStatus === 'suspended' ? (
          <PlatformButton label="Unsuspend" disabled={busy || !reason.trim()} onPress={() => run('unsuspend', {})} />
        ) : (
          <PlatformButton label="Suspend" danger disabled={busy || !reason.trim()} onPress={() => run('suspend', {})} />
        )}
      </ActionRow>

      <SectionLabel>Record payment</SectionLabel>
      <RecordPayment shop={shop} plans={plans} reason={reason} busy={busy} onRun={run} />

      {error ? <Text style={styles.error}>{error}</Text> : null}

      <DangerZone shop={shop} onDone={onDone} />

      <Text style={styles.privacyNote}>
        This portal cannot open this store&apos;s products, sales, books, or schedule.
      </Text>
    </View>
  );
}

// Deleting a shop. `shops` is the cascade root, so this destroys the
// catalogue, every sale, refunds, customers, books, payroll, shifts, stock and
// every branch. There is no undo anywhere in the system.
//
// Three deliberate pieces of friction, because the cost of a misclick here is
// somebody's business records:
//   1. collapsed by default, so it is never one tap away
//   2. shows what will actually be destroyed, counted, before offering the button
//   3. requires the shop's exact name retyped — a confirm dialog gets dismissed
//      by reflex, typing a name cannot be
//
// The server enforces the name match and an owner-role operator independently,
// so none of this is load-bearing on the client. The bento pass changed the
// surfaces and nothing else here.
function DangerZone({ shop, onDone }: { shop: PlatformShopRow; onDone: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const matches = typed.trim() === shop.shopName;
  const destroyed = LIMIT_RESOURCES.map((r) => ({ label: limitLabel(r.key).toLowerCase(), n: shop.usage[r.key] ?? 0 })).filter(
    (x) => x.n > 0 && x.label !== 'sales this month'
  );

  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      await callPlatformAdmin('delete_shop', { shopId: shop.shopId, confirmName: typed.trim() }, reason.trim());
      await onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete this shop.');
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <>
        <SectionLabel tone="danger">Danger zone</SectionLabel>
        <ActionRow>
          <PlatformButton label="Delete this store" danger onPress={() => setOpen(true)} />
        </ActionRow>
        <Text style={styles.hint}>Permanent. Use Suspend above if you only need to cut off access.</Text>
      </>
    );
  }

  return (
    <>
      <SectionLabel tone="danger">Danger zone</SectionLabel>
      <View style={styles.dangerBox}>
        <Text style={styles.dangerTitle}>Delete {shop.shopName}</Text>
        <Text style={styles.dangerBody}>
          This permanently destroys everything this store has recorded
          {destroyed.length > 0 ? ` — including ${destroyed.map((d) => `${d.n.toLocaleString()} ${d.label}`).join(', ')}` : ''}
          , along with its sales history, books and payroll. It cannot be undone, and we keep no copy.
        </Text>
        <Text style={styles.dangerBody}>
          If you only need to cut off access, <Text style={styles.dangerStrong}>Suspend</Text> above does that and is
          reversible.
        </Text>

        <Field
          value={reason}
          onChangeText={setReason}
          placeholder="Reason (required — goes into the audit log)"
          style={styles.dangerField}
        />
        <Field
          value={typed}
          onChangeText={setTyped}
          placeholder={`Type "${shop.shopName}" to confirm`}
          style={styles.dangerField}
        />

        {error ? <Text style={styles.error}>{error}</Text> : null}
        <ActionRow>
          <PlatformButton
            label={busy ? 'Deleting…' : 'Delete this shop forever'}
            danger
            disabled={busy || !matches || !reason.trim()}
            onPress={remove}
          />
          <Pressable onPress={() => setOpen(false)}>
            <Text style={styles.dangerCancel}>Cancel</Text>
          </Pressable>
        </ActionRow>
      </View>
    </>
  );
}

// Recording money that arrived by ZAAD or eDahab. This is the step that turns
// an approved plan into a *paying* customer: approving a tier moves what they
// can do, this moves `current_period_end`, and only shops with a live period
// count toward MRR.
//
// Defaults do the arithmetic an operator would otherwise do by hand at the end
// of a long day: today's date, the plan's own price, and a period running from
// wherever their cover currently ends — so paying a month late buys a month
// from today rather than a month that already elapsed.
function RecordPayment({
  shop,
  plans,
  reason,
  busy,
  onRun,
}: {
  shop: PlatformShopRow;
  plans: Plan[];
  reason: string;
  busy: boolean;
  onRun: (action: string, payload: Record<string, unknown>) => Promise<void>;
}) {
  // Stored, not effective: this defaults the amount and billing interval to
  // what the store is actually being charged, which is its stored plan even
  // when a retirement has moved its entitlements onto a successor already.
  const plan = plans.find((p) => p.key === shop.storedPlanKey);
  const months = periodMonths(plan?.billingInterval ?? null);
  const today = new Date().toISOString().slice(0, 10);
  // Paid time starts when free time ends. Taking the latest of their current
  // cover, their trial end, and today matters most for a shop that pays partway
  // through a trial: starting the period today would spend the month they just
  // bought against days they already had for nothing, and they would lapse
  // early having paid in good faith.
  const candidates = [today, shop.currentPeriodEnd?.slice(0, 10), shop.trialEndsAt?.slice(0, 10)].filter(
    (d): d is string => Boolean(d)
  );
  const from = candidates.sort().at(-1) as string;

  const [amount, setAmount] = useState(plan ? String(plan.priceCents / 100) : '');
  const [method, setMethod] = useState('ZAAD');
  const [ref, setRef] = useState('');
  const [paidAt, setPaidAt] = useState(today);
  const [coversFrom, setCoversFrom] = useState(from);
  const [coversTo, setCoversTo] = useState(addMonths(from, months));
  // Off by default: the fair thing is to honour the free days a shop was
  // promised. On, it converts them today and they give up the remainder.
  const [startNow, setStartNow] = useState(false);

  const trialing = shop.status === 'trialing';
  // Counted between two fixed date strings rather than against the clock:
  // reading the clock during render is impure, and `today` is already fixed for
  // this render anyway, so both figures agree by construction.
  const freeDaysLeft = shop.trialEndsAt ? daysBetween(today, shop.trialEndsAt.slice(0, 10)) : 0;

  // Flipping the toggle rewrites the period in place, so the dates on screen
  // always match what will actually be recorded.
  const applyStartNow = (next: boolean) => {
    setStartNow(next);
    const start = next ? today : from;
    setCoversFrom(start);
    setCoversTo(addMonths(start, months));
  };

  const submit = () =>
    onRun('record_payment', {
      payment: {
        amountCents: Math.round((Number(amount) || 0) * 100),
        currency: plan?.currency ?? 'USD',
        method,
        providerRef: ref.trim() || null,
        paidAt: new Date(paidAt).toISOString(),
        coversFrom: new Date(coversFrom).toISOString(),
        coversTo: new Date(coversTo).toISOString(),
        endTrialNow: startNow,
      },
    });

  return (
    <View>
      {trialing ? (
        <>
          <Pressable onPress={() => applyStartNow(!startNow)} style={styles.convertRow}>
            <View style={[styles.checkbox, startNow && styles.checkboxOn]}>
              {startNow ? <Text style={styles.checkboxTick}>✓</Text> : null}
            </View>
            <Text style={styles.convertLabel}>Start paying today — ends their trial now</Text>
          </Pressable>
          <Text style={styles.hint}>
            {startNow
              ? `They become a paying customer today and give up ${freeDaysLeft} free day${
                  freeDaysLeft === 1 ? '' : 's'
                }. Only do this if they asked for it.`
              : `Their ${freeDaysLeft} remaining free day${
                  freeDaysLeft === 1 ? '' : 's'
                } are kept — the paid period starts when the trial ends, and they count toward MRR from then.`}
          </Text>
        </>
      ) : null}

      <ActionRow style={styles.row}>
        {['ZAAD', 'eDahab', 'Cash', 'Bank'].map((m) => (
          <Chip key={m} label={m} active={method === m} onPress={() => setMethod(m)} />
        ))}
      </ActionRow>

      <ActionRow style={styles.row}>
        <LabelledField label={`Amount (${plan?.currency ?? 'USD'})`}>
          <Field value={amount} onChangeText={setAmount} keyboardType="decimal-pad" width={112} />
        </LabelledField>
        <LabelledField label="Reference">
          {/* The ZAAD/eDahab transaction id. Optional, but it is the only thing
              that ties this row back to the money if a payment is disputed. */}
          <Field value={ref} onChangeText={setRef} placeholder="634812" width={112} />
        </LabelledField>
        <LabelledField label="Paid on">
          <Field value={paidAt} onChangeText={setPaidAt} width={124} />
        </LabelledField>
        <LabelledField label="Covers from">
          <Field value={coversFrom} onChangeText={setCoversFrom} width={124} />
        </LabelledField>
        <LabelledField label="Covers to">
          <Field value={coversTo} onChangeText={setCoversTo} width={124} />
        </LabelledField>
      </ActionRow>

      <ActionRow style={styles.row}>
        {[1, 3, 12].map((n) => (
          <Chip key={n} label={`+${n} month${n === 1 ? '' : 's'}`} onPress={() => setCoversTo(addMonths(coversFrom, n))} />
        ))}
        <PlatformButton label="Record payment" disabled={busy || !reason.trim()} onPress={submit} />
      </ActionRow>

      <Text style={styles.hint}>
        Their access runs to {coversTo}, plus the grace period. Recording a payment does not change their tier — use
        Change plan for that.
      </Text>
    </View>
  );
}

// Whole days from one yyyy-mm-dd to another, floored at zero.
function daysBetween(fromIso: string, toIso: string): number {
  const ms = Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`);
  return Number.isNaN(ms) ? 0 : Math.max(0, Math.round(ms / 86_400_000));
}

// Calendar-month arithmetic on a yyyy-mm-dd string. Clamps the day so paying on
// the 31st cannot roll a one-month period into the month after next — a
// customer who pays on 31 January is covered to 28 February, not 3 March.
function addMonths(iso: string, months: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, lastDay));
  return target.toISOString().slice(0, 10);
}

const styles = StyleSheet.create({
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
  meta: { fontSize: 12, color: theme.bentoMuted },

  usageRow: { flexDirection: 'row', justifyContent: 'space-between', gap: 12, paddingVertical: 5 },
  usageLabel: { fontSize: 12.5, color: theme.bentoInk2 },
  usageValue: { fontSize: 12.5, fontWeight: '800', color: theme.bentoInk, fontVariant: ['tabular-nums'] },
  usageValueAtLimit: { color: theme.bentoLoss },

  modules: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  modulePill: { backgroundColor: theme.bentoSoft, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4 },
  moduleText: { fontSize: 11, fontWeight: '700', color: theme.bentoInk2 },
  moduleTextOff: { color: theme.bentoMuted2 },

  caveat: { marginTop: 10 },
  row: { marginTop: 12 },
  inlineDays: { flexDirection: 'row', gap: 6, alignItems: 'center' },
  daysField: { textAlign: 'center' },

  convertRow: { flexDirection: 'row', alignItems: 'center', gap: 9, paddingVertical: 6 },
  checkbox: {
    width: 18,
    height: 18,
    borderRadius: 5,
    borderWidth: 1.5,
    borderColor: theme.bentoMuted2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkboxOn: { backgroundColor: theme.bentoInk, borderColor: theme.bentoInk },
  checkboxTick: { color: theme.bentoSurface, fontSize: 11, fontWeight: '800' },
  convertLabel: { fontSize: 12.5, color: theme.bentoInk, fontWeight: '700' },

  hint: { fontSize: 11.5, color: theme.bentoMuted, lineHeight: 17, marginTop: 8 },
  error: { color: theme.bentoLoss, fontSize: 12, fontWeight: '700', marginTop: 10 },
  privacyNote: { color: theme.bentoMuted2, fontSize: 11, lineHeight: 17, marginTop: 20 },

  // Loss-tinted panel rather than a bordered box, but every piece of friction
  // is unchanged: collapsed by default, the counted list, the retyped name.
  dangerBox: {
    backgroundColor: `${theme.bentoLoss}0A`,
    borderRadius: 20,
    padding: 16,
    gap: 10,
  },
  dangerTitle: { color: theme.bentoLoss, fontSize: 14, fontWeight: '800' },
  dangerBody: { color: theme.bentoInk2, fontSize: 12.5, lineHeight: 19 },
  dangerStrong: { fontWeight: '800' },
  dangerField: { backgroundColor: theme.bentoSurface },
  dangerCancel: { color: theme.bentoMuted, fontSize: 12, fontWeight: '700', paddingHorizontal: 8 },
});
