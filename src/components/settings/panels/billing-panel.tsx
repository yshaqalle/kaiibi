import { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { Badge, PageHeader, Row, Section } from '@/components/settings/settings-primitives';
import { useAuth } from '@/hooks/use-auth';
import { formatCents } from '@/lib/currency';
import { daysUntil, LIMIT_RESOURCES, MODULES } from '@/lib/entitlements';
import { listPlans, type Plan } from '@/lib/subscriptions';

// What the shop is paying for, what it is using, and how to pay. Read-only by
// design: there is no in-app purchase flow here, and deliberately so. Payment in
// this region is ZAAD/eDahab confirmed by hand, and an in-app purchase button on
// iOS would pull the whole app under Apple's IAP rules for a transaction that
// never touches the device. So this screen tells you what to send and where.
export function BillingPanel() {
  const { entitlements, subscriptionStatus, shop } = useAuth();
  const [plans, setPlans] = useState<Plan[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    listPlans()
      .then((rows) => {
        if (active) setPlans(rows);
      })
      // A failed plan list costs the comparison table, not the panel: the
      // shop's own status and usage come from context and are already resolved.
      .catch(() => {})
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const trialDays = daysUntil(entitlements.trialEndsAt);
  const periodDays = daysUntil(entitlements.currentPeriodEnd);

  return (
    <View>
      <PageHeader title="Plan and billing" />

      <Section title="Your plan">
        {entitlements.resolved ? (
          <View style={[styles.statusCard, STATUS_STYLE[subscriptionStatus].card]}>
            <Text style={[styles.statusName, STATUS_STYLE[subscriptionStatus].text]}>
              {entitlements.planName.toUpperCase()}
              {subscriptionStatus === 'trialing' && trialDays != null ? ` · ${trialDays} days left` : ''}
            </Text>
            <Text style={styles.statusLine}>{statusLine(subscriptionStatus, trialDays, periodDays)}</Text>
          </View>
        ) : (
          // We could not reach the plan lookup. Restrictions still apply, but
          // saying "your plan has ended" here would be a false accusation
          // against a customer who may be fully paid up.
          <View style={[styles.statusCard, STATUS_STYLE.unresolved.card]}>
            <Text style={[styles.statusName, STATUS_STYLE.unresolved.text]}>CHECKING YOUR PLAN</Text>
            <Text style={styles.statusLine}>
              We couldn&apos;t check your plan just now, so some things are limited until we can. This is a problem on
              our side, not with your account — try again in a moment.
            </Text>
          </View>
        )}
      </Section>

      <Section title="What you're using">
        {LIMIT_RESOURCES.map((resource) => (
          <UsageRow
            key={resource.key}
            label={resource.label}
            usage={entitlements.usage[resource.key] ?? 0}
            limit={entitlements.limits[resource.key] ?? null}
          />
        ))}
        <Text style={styles.note}>
          Counted across your whole business, not per store — one catalog and one customer list, however many
          branches you run.
        </Text>
      </Section>

      <Section title="What's included">
        {MODULES.map((module) => {
          const included = entitlements.modules.includes(module.key);
          return (
            <Row
              key={module.key}
              label={module.label}
              desc={module.description}
              badge={included ? undefined : <Badge variant="pro">Upgrade</Badge>}
            >
              <Text style={[styles.tick, included ? styles.tickOn : styles.tickOff]}>{included ? '✓' : '—'}</Text>
            </Row>
          );
        })}
      </Section>

      {loading ? (
        <ActivityIndicator style={styles.loader} />
      ) : plans.length > 0 ? (
        <Section title="Plans">
          {plans.map((plan) => (
            <Row
              key={plan.id}
              label={plan.name}
              desc={plan.description ?? undefined}
              badge={plan.key === entitlements.planKey ? <Badge>Current</Badge> : undefined}
            >
              <Text style={styles.price}>
                {plan.priceCents === 0 ? 'Free' : `${formatCents(plan.priceCents)}/${plan.billingInterval ?? 'month'}`}
              </Text>
            </Row>
          ))}
        </Section>
      ) : null}

      <Section title="How to pay">
        <Text style={styles.payBody}>
          Send payment by ZAAD or eDahab, then send us the transaction reference on WhatsApp along with your
          business name{shop?.name ? ` (${shop.name})` : ''}. We activate your plan within one business day.
        </Text>
        <Text style={styles.payBody}>
          Nothing is ever deleted if a plan lapses — your sales, stock and books stay readable, and you keep what
          you have already added. You just can&apos;t add anything new until it&apos;s active again.
        </Text>
      </Section>
    </View>
  );
}

function UsageRow({ label, usage, limit }: { label: string; usage: number; limit: number | null }) {
  // An unlimited resource gets no bar: a progress meter with no end is
  // meaningless, and a full-looking one would read as a cap that isn't there.
  const unlimited = limit == null;
  const ratio = unlimited || limit === 0 ? 0 : Math.min(1, usage / limit);
  const atLimit = !unlimited && usage >= limit;

  return (
    <Row label={label}>
      <View style={styles.usage}>
        <Text style={[styles.usageText, atLimit && styles.usageTextAtLimit]}>
          {usage.toLocaleString()} / {unlimited ? '∞' : limit.toLocaleString()}
        </Text>
        {!unlimited && (
          <View style={styles.track}>
            <View style={[styles.fill, { width: `${ratio * 100}%` }, atLimit && styles.fillAtLimit]} />
          </View>
        )}
      </View>
    </Row>
  );
}

function statusLine(status: string, trialDays: number | null, periodDays: number | null): string {
  switch (status) {
    case 'trialing':
      return 'Full access to every part of Kaiibi while you try it out.';
    case 'active':
      return periodDays != null ? `Renews in ${periodDays} day${periodDays === 1 ? '' : 's'}.` : 'Your plan is active.';
    case 'grace':
      return periodDays != null
        ? `Payment is due. You have ${periodDays} day${periodDays === 1 ? '' : 's'} before changes are paused.`
        : 'Payment is due. Send it soon to avoid a pause.';
    case 'suspended':
      return 'This account is paused. Please get in touch with us.';
    default:
      return 'Your plan has ended. You can still see everything, but not add or change anything.';
  }
}

const STATUS_STYLE: Record<string, { card: object; text: object }> = {
  unresolved: { card: { backgroundColor: '#FAFAFA', borderColor: '#E0E0E0' }, text: { color: '#666666' } },
  trialing: { card: { backgroundColor: '#F1F6FF', borderColor: '#B9D2FF' }, text: { color: '#1B4FA8' } },
  active: { card: { backgroundColor: '#F1FAF3', borderColor: '#B6E3C4' }, text: { color: '#1E7A3C' } },
  grace: { card: { backgroundColor: '#FFF8EC', borderColor: '#F2D8A8' }, text: { color: '#9A6412' } },
  expired: { card: { backgroundColor: '#FDF2F2', borderColor: '#F0C2C2' }, text: { color: '#B03535' } },
  suspended: { card: { backgroundColor: '#FDF2F2', borderColor: '#F0C2C2' }, text: { color: '#B03535' } },
};

const styles = StyleSheet.create({
  statusCard: { borderWidth: 1, borderRadius: 10, padding: 16, gap: 6 },
  statusName: { fontSize: 15, fontWeight: '800', letterSpacing: 0.5 },
  statusLine: { color: '#555555', fontSize: 13, lineHeight: 19 },
  usage: { alignItems: 'flex-end', gap: 6, minWidth: 132 },
  usageText: { color: '#111111', fontSize: 13, fontWeight: '700' },
  usageTextAtLimit: { color: '#B03535' },
  track: { width: 120, height: 5, borderRadius: 3, backgroundColor: '#EEEEEE', overflow: 'hidden' },
  fill: { height: 5, borderRadius: 3, backgroundColor: '#111111' },
  fillAtLimit: { backgroundColor: '#B03535' },
  tick: { fontSize: 15, fontWeight: '800' },
  tickOn: { color: '#1E7A3C' },
  tickOff: { color: '#BBBBBB' },
  price: { color: '#111111', fontSize: 13, fontWeight: '800' },
  note: { color: '#777777', fontSize: 12, lineHeight: 18, marginTop: 10 },
  payBody: { color: '#555555', fontSize: 13, lineHeight: 20, marginBottom: 12 },
  loader: { marginVertical: 20 },
});
