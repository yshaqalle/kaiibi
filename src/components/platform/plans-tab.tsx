import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { planColor } from '@/components/platform-charts';
import { PlanEditor } from '@/components/platform/plan-editor';
import { PlanRetireModal } from '@/components/platform/plan-retire-modal';
import { Chip, PlatformButton, PlatformModal } from '@/components/platform/kit';
import { limitLabel } from '@/components/platform/labels';
import { Card } from '@/components/card';
import { BentoCell, BentoGrid } from '@/components/ui/bento';
import { Caveat } from '@/components/ui/caveat';
import { BENTO_RADIUS_TILE, Colors } from '@/constants/theme';
import { formatCents } from '@/lib/currency';
import { LIMIT_RESOURCES, MODULES } from '@/lib/entitlements';
import type { PlatformShopRow } from '@/lib/platform';
import type { Plan } from '@/lib/subscriptions';

// Pinned to the light palette for now — no dark-mode switching yet.
const theme = Colors.light;

// The tiers, side by side.
//
// This is the one tab where the grid is not cosmetic. These were stacked
// full-width rows, so comparing what Pro adds over Standard meant scrolling and
// remembering. At `span={4}` the three sit in a row and the comparison is the
// layout.
//
// The 5px accent stripe each card used to carry is gone — bento cards have no
// edge decoration, and a 5px bar reads as a border at a glance. The tier's
// colour survives as the dot beside its name and the colour of its headline
// shop count, which is all it was ever for: matching a slice in the donut on
// the Overview.

export function PlansTab({
  plans,
  shops,
  compact,
  pendingRequestsByPlanKey,
  postTrialPlanKey,
  onDone,
}: {
  plans: Plan[];
  shops: PlatformShopRow[];
  compact: boolean;
  pendingRequestsByPlanKey: Record<string, number>;
  postTrialPlanKey: string;
  onDone: () => Promise<void>;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const editingPlan = plans.find((p) => p.key === editing) ?? null;
  const [retiring, setRetiring] = useState<string | null>(null);
  const retiringPlan = plans.find((p) => p.key === retiring) ?? null;

  // The span that leaves no orphan on the last row. Four tiers at span 4 puts
  // three across and strands the fourth alone, which is what shipped first;
  // 2x2 compares just as well and does not look broken. Four across was the
  // other option and is worse — these cards carry twelve module pills and six
  // limit tiles, and at a quarter of the width they wrap into columns of soup.
  const span = plans.length === 1 ? 12 : plans.length === 2 || plans.length === 4 ? 6 : 4;

  return (
    <View>
      <BentoGrid>
        {plans.map((plan, i) => (
          <BentoCell key={plan.id} span={span}>
            <PlanCard
              plan={plan}
              accent={planColor(plan.key, i)}
              shopsOn={shops.filter((s) => s.planKey === plan.key).length}
              revenue={plan.priceCents * shops.filter((s) => s.planKey === plan.key && s.status === 'active').length}
              successorName={plans.find((p) => p.key === plan.successorPlanKey)?.name ?? null}
              onEdit={() => setEditing(plan.key)}
              onRetire={() => setRetiring(plan.key)}
            />
          </BentoCell>
        ))}
      </BentoGrid>

      <Caveat tone="context">
        Editing a tier changes entitlements for every store on it at once. Removing a module makes that data read-only
        for them immediately; lowering a cap keeps their existing records and blocks new ones.
      </Caveat>

      {/* A modal, not an inline swap: the editor is a form, and dropping a form
          into a row-laid-out card list mangled both. */}
      {editingPlan ? (
        <PlatformModal title={`Edit ${editingPlan.name}`} compact={compact} onClose={() => setEditing(null)}>
          <PlanEditor
            plan={editingPlan}
            shopsOn={shops.filter((s) => s.planKey === editingPlan.key).length}
            shops={shops}
            onClose={() => setEditing(null)}
            onDone={onDone}
          />
        </PlatformModal>
      ) : null}

      {retiringPlan ? (
        <PlatformModal
          title={retiringPlan.retireAt ? `Republish ${retiringPlan.name}` : `Retire ${retiringPlan.name}`}
          compact={compact}
          onClose={() => setRetiring(null)}
        >
          <PlanRetireModal
            plan={retiringPlan}
            plans={plans}
            shopsOn={shops.filter((s) => s.planKey === retiringPlan.key).length}
            pendingRequests={pendingRequestsByPlanKey[retiringPlan.key] ?? 0}
            postTrialPlanKey={postTrialPlanKey}
            onClose={() => setRetiring(null)}
            onDone={onDone}
          />
        </PlatformModal>
      ) : null}
    </View>
  );
}

// Whole days, rounded up: "retires in 0 days" on the morning of the last day is
// wrong in the direction that matters.
function daysUntilRetire(retireAt: string): number {
  return Math.max(0, Math.ceil((new Date(retireAt).getTime() - Date.now()) / 86_400_000));
}

function PlanCard({
  plan,
  accent,
  shopsOn,
  revenue,
  successorName,
  onEdit,
  onRetire,
}: {
  plan: Plan;
  accent: string;
  shopsOn: number;
  revenue: number;
  successorName: string | null;
  onEdit: () => void;
  onRetire: () => void;
}) {
  // A bare bento card rather than `BentoCard`: the head here is a colour dot,
  // the tier name and two controls, which is not the title/scope-pill shape
  // BentoCard exists to standardise.
  return (
    <Card variant="bento" style={styles.card}>
      <View style={styles.head}>
        <View style={styles.nameRow}>
          <View style={[styles.dot, { backgroundColor: accent }]} />
          <Text style={styles.name} numberOfLines={1}>
            {plan.name}
          </Text>
          {/* The glyph, not just the amber: bentoWarn is a status colour and
              colour alone is never the signal. */}
          {plan.retireAt ? (
            <Chip label={`⚠ Retires in ${daysUntilRetire(plan.retireAt)} days`} />
          ) : !plan.isPublic ? (
            <Chip label="Not public" />
          ) : null}
        </View>
        <View style={styles.headButtons}>
          <PlatformButton label="Edit" onPress={onEdit} />
          <PlatformButton label={plan.retireAt ? 'Republish' : 'Retire'} onPress={onRetire} />
        </View>
      </View>

      <View style={styles.priceRow}>
        <Text style={styles.price}>{plan.priceCents === 0 ? 'Free' : formatCents(plan.priceCents)}</Text>
        {plan.priceCents > 0 ? <Text style={styles.per}>/{plan.billingInterval ?? 'month'}</Text> : null}
      </View>

      <View style={styles.stats}>
        <View>
          <Text style={[styles.statValue, { color: accent }]}>{shopsOn}</Text>
          <Text style={styles.statLabel}>store{shopsOn === 1 ? '' : 's'}</Text>
        </View>
        <View>
          <Text style={styles.statValue}>{revenue > 0 ? formatCents(revenue) : '—'}</Text>
          <Text style={styles.statLabel}>monthly revenue</Text>
        </View>
        <View>
          <Text style={styles.statValue}>
            {plan.modules.length}
            <Text style={styles.statOf}>/{MODULES.length}</Text>
          </Text>
          <Text style={styles.statLabel}>modules</Text>
        </View>
      </View>

      {plan.retireAt && successorName ? (
        <View style={styles.retireStrip}>
          <Text style={styles.retireGlyph}>→</Text>
          <Text style={styles.retireText}>
            Hidden from the plan picker. On {new Date(plan.retireAt).toLocaleDateString()} the {shopsOn} store
            {shopsOn === 1 ? '' : 's'} still here move to {successorName}.
          </Text>
        </View>
      ) : null}

      {/* Every module shown, not just the included ones — what a tier leaves
          out is what sells the tier above it, and that is invisible if excluded
          features simply aren't listed. */}
      <Text style={styles.subhead}>WHAT&apos;S INCLUDED</Text>
      <View style={styles.pills}>
        {MODULES.map((m) => {
          const on = plan.modules.includes(m.key);
          return (
            <View key={m.key} style={[styles.pill, on && { backgroundColor: `${accent}1F` }]}>
              <Text style={[styles.pillText, on ? styles.pillTextOn : styles.pillTextOff]}>
                {on ? '' : '✕ '}
                {m.label}
              </Text>
            </View>
          );
        })}
      </View>

      <Text style={styles.subhead}>LIMITS</Text>
      <View style={styles.limits}>
        {LIMIT_RESOURCES.map((r) => {
          const limit = plan.limits[r.key];
          return (
            <View key={r.key} style={styles.limit}>
              <Text style={styles.limitValue}>{limit == null ? '∞' : limit.toLocaleString()}</Text>
              <Text style={styles.limitLabel} numberOfLines={1}>
                {limitLabel(r.key)}
              </Text>
            </View>
          );
        })}
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  card: { padding: 18 },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 1 },
  dot: { width: 9, height: 9, borderRadius: 3 },
  name: { fontSize: 16, fontWeight: '800', letterSpacing: -0.3, color: theme.bentoInk },
  headButtons: { flexDirection: 'row', gap: 7, flexShrink: 0 },
  // The amber wash has no token: bentoWarn is the ink, and a soft tile
  // (`bentoSoft`) behind amber text reads as disabled rather than as a warning.
  // Kept local rather than invented as a token for one use.
  retireStrip: { flexDirection: 'row', alignItems: 'flex-start', gap: 9, marginTop: 14, padding: 12, backgroundColor: '#fdf4e3', borderRadius: BENTO_RADIUS_TILE },
  retireGlyph: { fontSize: 13, color: theme.bentoWarn, fontWeight: '800' },
  retireText: { flex: 1, fontSize: 11.5, lineHeight: 17, fontWeight: '700', color: theme.bentoWarn },

  priceRow: { flexDirection: 'row', alignItems: 'baseline', gap: 3, marginTop: 12 },
  price: { fontSize: 28, fontWeight: '800', letterSpacing: -1, color: theme.bentoInk, fontVariant: ['tabular-nums'] },
  per: { fontSize: 12, fontWeight: '700', color: theme.bentoMuted },

  stats: { flexDirection: 'row', gap: 22, marginTop: 14, flexWrap: 'wrap' },
  statValue: { fontSize: 17, fontWeight: '800', color: theme.bentoInk, fontVariant: ['tabular-nums'] },
  statOf: { fontSize: 12, fontWeight: '700', color: theme.bentoMuted2 },
  statLabel: { fontSize: 10.5, color: theme.bentoMuted },

  subhead: { fontSize: 9.5, fontWeight: '800', letterSpacing: 1, color: theme.bentoMuted2, marginTop: 18, marginBottom: 8 },

  pills: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  pill: { backgroundColor: theme.bentoSoft, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4 },
  pillText: { fontSize: 11, fontWeight: '700' },
  // Ink on the tier's tint, not the tier's hue on white. `bentoSeries3` at
  // 11px is about 3.3:1 on white -- under the 4.5 small text needs -- and the
  // tint alone carries the tier identity perfectly well.
  pillTextOn: { color: theme.bentoInk2 },
  pillTextOff: { color: theme.bentoMuted2 },

  limits: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  limit: { backgroundColor: theme.bentoSoft, borderRadius: BENTO_RADIUS_TILE, paddingVertical: 9, paddingHorizontal: 11, minWidth: 84, flexGrow: 1 },
  // No green on the unlimited case. `bentoProfit` is a STATUS colour and "no
  // cap" is not profit; six green infinities on the Trial card read as six good
  // things rather than six absent limits. The glyph already says it.
  limitValue: { fontSize: 14, fontWeight: '800', color: theme.bentoInk, fontVariant: ['tabular-nums'] },
  limitLabel: { fontSize: 9.5, color: theme.bentoMuted, marginTop: 1 },
});
