import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { planColor } from '@/components/platform-charts';
import { PlanEditor } from '@/components/platform/plan-editor';
import { PlanLifecycleModal } from '@/components/platform/plan-lifecycle-modal';
import { PlanRetireModal } from '@/components/platform/plan-retire-modal';
import { Chip, PlatformButton, PlatformModal } from '@/components/platform/kit';
import { limitLabel } from '@/components/platform/labels';
import { Card } from '@/components/card';
import { BentoCell, BentoGrid } from '@/components/ui/bento';
import { Caveat } from '@/components/ui/caveat';
import { BENTO_RADIUS, BENTO_RADIUS_TILE, Colors } from '@/constants/theme';
import { formatCents } from '@/lib/currency';
import { LIMIT_RESOURCES, MODULES } from '@/lib/entitlements';
import { canArchivePlan, canPublishPlan } from '@/lib/plan-lifecycle';
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
  archivedPlans,
  shops,
  compact,
  pendingRequestsByPlanKey,
  postTrialPlanKey,
  onDone,
}: {
  plans: Plan[];
  archivedPlans: Plan[];
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
  const [creating, setCreating] = useState(false);
  const [lifecycle, setLifecycle] = useState<{ mode: 'publish' | 'archive' | 'restore'; planKey: string } | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const lifecyclePlan = lifecycle
    ? ([...plans, ...archivedPlans].find((p) => p.key === lifecycle.planKey) ?? null)
    : null;

  // The span that leaves no orphan on the last row -- counting the ghost
  // "new plan" cell, which takes a normal grid slot. Three plans + ghost = 4
  // slots = 2x2; four across is worse -- these cards carry twelve module
  // pills and six limit tiles, and at a quarter of the width they wrap into
  // columns of soup.
  const slots = plans.length + 1;
  const span = slots === 1 ? 12 : slots === 2 || slots === 4 ? 6 : 4;

  return (
    <View>
      <BentoGrid>
        {plans.map((plan, i) => {
          // Stored, not effective: this card is about the plan RECORD --
          // how many subscriptions still point here and how much money it
          // brings in -- not about who is currently enforced under it.
          // Keyed off effective plan, a retired tier's card would read "0
          // stores" forever, which is exactly wrong for the strip below
          // that still needs to say how many are moving. It is also the
          // count archive_plan checks, which is what lets canArchivePlan
          // mirror the server guard exactly.
          const storedShopsOn = shops.filter((s) => s.storedPlanKey === plan.key).length;
          return (
            <BentoCell key={plan.id} span={span}>
              <PlanCard
                plan={plan}
                accent={planColor(plan.key, i)}
                shopsOn={storedShopsOn}
                revenue={plan.priceCents * shops.filter((s) => s.storedPlanKey === plan.key && s.status === 'active').length}
                successorName={plans.find((p) => p.key === plan.successorPlanKey)?.name ?? null}
                onEdit={() => setEditing(plan.key)}
                onRetire={() => setRetiring(plan.key)}
                onPublish={canPublishPlan(plan) ? () => setLifecycle({ mode: 'publish', planKey: plan.key }) : null}
                onArchive={
                  canArchivePlan(plan, { storedShopsOn, postTrialPlanKey, plans })
                    ? () => setLifecycle({ mode: 'archive', planKey: plan.key })
                    : null
                }
              />
            </BentoCell>
          );
        })}

        <BentoCell span={span}>
          <Pressable onPress={() => setCreating(true)} style={styles.ghost}>
            <Text style={styles.ghostPlus}>＋</Text>
            <Text style={styles.ghostTitle}>New plan</Text>
            <Text style={styles.ghostHint}>Starts hidden — publish it when it&apos;s ready</Text>
          </Pressable>
        </BentoCell>
      </BentoGrid>

      <Caveat tone="context">
        Editing a tier changes entitlements for every store on it at once. Removing a module makes that data read-only
        for them immediately; lowering a cap keeps their existing records and blocks new ones.
      </Caveat>

      {/* The way back through the active=false door. Rows offer Restore and
          nothing else -- no Edit, which is what keeps updated_at an honest
          "archived" date. */}
      {archivedPlans.length > 0 ? (
        <Card variant="bento" style={styles.archStrip}>
          <Pressable onPress={() => setShowArchived((v) => !v)} style={styles.archHead}>
            <Text style={styles.archCaret}>{showArchived ? '▾' : '▸'}</Text>
            <Text style={styles.archTitle}>Archived · {archivedPlans.length}</Text>
          </Pressable>
          {showArchived
            ? archivedPlans.map((p) => (
                <View key={p.id} style={styles.archRow}>
                  <View style={styles.archInfo}>
                    <Text style={styles.archName} numberOfLines={1}>
                      {p.name} <Text style={styles.archKey}>{p.key}</Text>
                    </Text>
                    <Text style={styles.archMeta} numberOfLines={1}>
                      {p.priceCents === 0 ? '$0' : `${formatCents(p.priceCents)}/${p.billingInterval ?? 'month'}`}
                      {' · archived '}
                      {new Date(p.updatedAt).toLocaleDateString()}
                      {p.successorPlanKey
                        ? ` · was retired into ${plans.find((a) => a.key === p.successorPlanKey)?.name ?? p.successorPlanKey}`
                        : ''}
                    </Text>
                  </View>
                  <PlatformButton label="Restore" onPress={() => setLifecycle({ mode: 'restore', planKey: p.key })} />
                </View>
              ))
            : null}
        </Card>
      ) : null}

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
            // Stored, not effective, matching every other count on this tab
            // (see the card's shopsOn above): a plan past its retire date is
            // exactly when republishing brings stores keyed off planKey back
            // to zero here, which is the false "0 stores on it" this sheet
            // must not say.
            shopsOn={shops.filter((s) => s.storedPlanKey === retiringPlan.key).length}
            pendingRequests={pendingRequestsByPlanKey[retiringPlan.key] ?? 0}
            postTrialPlanKey={postTrialPlanKey}
            onClose={() => setRetiring(null)}
            onDone={onDone}
          />
        </PlatformModal>
      ) : null}

      {creating ? (
        <PlatformModal title="New plan" compact={compact} onClose={() => setCreating(false)}>
          <PlanEditor plan={null} shopsOn={0} shops={shops} onClose={() => setCreating(false)} onDone={onDone} />
        </PlatformModal>
      ) : null}

      {lifecycle && lifecyclePlan ? (
        <PlatformModal
          title={`${{ publish: 'Publish', archive: 'Archive', restore: 'Restore' }[lifecycle.mode]} ${lifecyclePlan.name}`}
          compact={compact}
          onClose={() => setLifecycle(null)}
        >
          <PlanLifecycleModal
            mode={lifecycle.mode}
            plan={lifecyclePlan}
            onClose={() => setLifecycle(null)}
            onDone={onDone}
          />
        </PlatformModal>
      ) : null}
    </View>
  );
}

// Whole days, rounded up: "retires in 0 days" on the morning of the last day is
// wrong in the direction that matters. Can go negative past the date -- callers
// treat that as "already retired" rather than clamping to zero, because
// retire_at is never cleared by the passage of time, only by an operator
// republishing (the same reasoning shops-tab.tsx's row arrow already carries).
// Clamping here would make a plan that stayed retired for a year read "retires
// in 0 days" forever.
function daysUntilRetire(retireAt: string): number {
  return Math.ceil((new Date(retireAt).getTime() - Date.now()) / 86_400_000);
}

function PlanCard({
  plan,
  accent,
  shopsOn,
  revenue,
  successorName,
  onEdit,
  onRetire,
  onPublish,
  onArchive,
}: {
  plan: Plan;
  accent: string;
  shopsOn: number;
  revenue: number;
  successorName: string | null;
  onEdit: () => void;
  onRetire: () => void;
  onPublish: (() => void) | null;
  onArchive: (() => void) | null;
}) {
  // Past the date the countdown has nothing left to count -- said outright
  // rather than as "0 days", which would read as a countdown still running.
  const daysLeft = plan.retireAt ? daysUntilRetire(plan.retireAt) : null;
  const retired = daysLeft != null && daysLeft <= 0;

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
          {daysLeft != null ? (
            <Chip label={retired ? '⚠ Retired' : `⚠ Retires in ${daysLeft} day${daysLeft === 1 ? '' : 's'}`} />
          ) : !plan.isPublic ? (
            <Chip label="Not public" />
          ) : null}
        </View>
        <View style={styles.headButtons}>
          <PlatformButton label="Edit" onPress={onEdit} />
          {/* Handlers arrive null when the matching server guard would
              reject -- the same only-offer-what-the-server-takes rule the
              Retire button below already follows. */}
          {onPublish ? <PlatformButton label="Publish" onPress={onPublish} /> : null}
          {/* Retire only where the server will actually take it: retire_plan
              rejects any plan whose is_public is already false (Trial, or
              anything already retiring) -- offering the button there is
              asking for a click that always errors. Republish stays
              regardless of isPublic: a retired plan IS non-public by
              definition and has to stay reachable to bring back. */}
          {plan.retireAt || plan.isPublic ? (
            <PlatformButton label={plan.retireAt ? 'Republish' : 'Retire'} onPress={onRetire} />
          ) : null}
          {onArchive ? <PlatformButton label="Archive" onPress={onArchive} /> : null}
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
            {retired ? (
              <>
                Hidden from the plan picker. Since {new Date(plan.retireAt).toLocaleDateString()} the {shopsOn} store
                {shopsOn === 1 ? '' : 's'} still here {shopsOn === 1 ? 'has' : 'have'} moved to {successorName}.
              </>
            ) : (
              <>
                Hidden from the plan picker. On {new Date(plan.retireAt).toLocaleDateString()} the {shopsOn} store
                {shopsOn === 1 ? '' : 's'} still here move to {successorName}.
              </>
            )}
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
  name: { fontSize: 16, fontWeight: '800', letterSpacing: -0.3, color: theme.bentoInk, flexShrink: 1 },
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

  // Deliberately not a Card: the dashed outline says "a slot, not a tier",
  // which is the one job edge decoration has on this grid.
  ghost: { flex: 1, borderWidth: 1.5, borderStyle: 'dashed', borderColor: theme.bentoLine, borderRadius: BENTO_RADIUS, alignItems: 'center', justifyContent: 'center', gap: 6, padding: 26, minHeight: 150 },
  ghostPlus: { fontSize: 22, fontWeight: '800', color: theme.bentoMuted },
  ghostTitle: { fontSize: 12.5, fontWeight: '800', color: theme.bentoInk2 },
  ghostHint: { fontSize: 10.5, color: theme.bentoMuted2, textAlign: 'center', maxWidth: 200 },

  archStrip: { marginTop: 14, paddingVertical: 6, paddingHorizontal: 16 },
  archHead: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 10 },
  archCaret: { fontSize: 9, color: theme.bentoMuted2 },
  archTitle: { fontSize: 11, fontWeight: '800', letterSpacing: 0.6, color: theme.bentoMuted2, textTransform: 'uppercase' },
  archRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, paddingVertical: 11, borderTopWidth: 1, borderTopColor: theme.bentoLine },
  archInfo: { flexShrink: 1 },
  archName: { fontSize: 13, fontWeight: '700', color: theme.bentoInk },
  archKey: { fontSize: 11, fontWeight: '400', color: theme.bentoMuted },
  archMeta: { fontSize: 10.5, color: theme.bentoMuted, marginTop: 1 },
});
