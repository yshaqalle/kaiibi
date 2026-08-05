import { useRouter } from 'expo-router';
import { StyleSheet, Text, useWindowDimensions, View } from 'react-native';

import { LandingSection } from '@/components/landing/landing-section';
import { Btn, SectionHead, gridCellStyle, gridRowStyle } from '@/components/landing/landing-ui';
import { SUPPORT_EMAIL } from '@/constants/contact';
import { Marketing, MarketingLayout, MarketingRadius, MarketingShadowLg } from '@/constants/marketing-theme';
import { useLocale } from '@/hooks/use-locale';
import { openExternalUrl } from '@/lib/external-url';
import type { MessageKey } from '@/lib/i18n';

// Four plans, no prices — pricing for Standard and Pro isn't set yet.
//
// Copy is static rather than read from `listAllPlans()`: the point of these
// cards is that they DON'T show prices, so fetching a price table to not
// display it would be work for nothing. When pricing is announced, that
// function already exists in lib/subscriptions.ts.
//
// Two CTAs differ from the design. Standard's "Join the waitlist" became
// "Start free" -> /signup, because no waitlist exists and a Free signup
// captures the same contact details. Pro's "Talk to us" is email rather than
// WhatsApp — see constants/contact.ts.

type PlanCta = { kind: 'signup' } | { kind: 'email' };

type Plan = {
  key: string;
  name: MessageKey;
  for: MessageKey;
  price: MessageKey;
  priceNote: MessageKey;
  features: MessageKey[];
  cta: MessageKey;
  action: PlanCta;
  featured?: boolean;
};

const PLANS: Plan[] = [
  {
    key: 'free',
    name: 'plans.free.name',
    for: 'plans.free.for',
    price: 'plans.free.price',
    priceNote: 'plans.free.priceNote',
    features: ['plans.free.f1', 'plans.free.f2', 'plans.free.f3', 'plans.free.f4', 'plans.free.f5'],
    cta: 'plans.free.cta',
    action: { kind: 'signup' },
  },
  {
    key: 'trial',
    name: 'plans.trial.name',
    for: 'plans.trial.for',
    price: 'plans.trial.price',
    priceNote: 'plans.trial.priceNote',
    features: ['plans.trial.f1', 'plans.trial.f2', 'plans.trial.f3', 'plans.trial.f4'],
    cta: 'plans.trial.cta',
    action: { kind: 'signup' },
  },
  {
    key: 'standard',
    name: 'plans.standard.name',
    for: 'plans.standard.for',
    price: 'plans.standard.price',
    priceNote: 'plans.standard.priceNote',
    features: [
      'plans.standard.f1',
      'plans.standard.f2',
      'plans.standard.f3',
      'plans.standard.f4',
      'plans.standard.f5',
      'plans.standard.f6',
    ],
    cta: 'plans.standard.cta',
    action: { kind: 'signup' },
    featured: true,
  },
  {
    key: 'pro',
    name: 'plans.pro.name',
    for: 'plans.pro.for',
    price: 'plans.pro.price',
    priceNote: 'plans.pro.priceNote',
    features: [
      'plans.pro.f1',
      'plans.pro.f2',
      'plans.pro.f3',
      'plans.pro.f4',
      'plans.pro.f5',
      'plans.pro.f6',
    ],
    cta: 'plans.pro.cta',
    action: { kind: 'email' },
  },
];

const GUTTER = 18;

export function LandingPlans() {
  const router = useRouter();
  const { t } = useLocale();
  const { width } = useWindowDimensions();

  const columns = width >= 1050 ? 4 : width >= MarketingLayout.narrowBreakpoint ? 2 : 1;

  return (
    <LandingSection id="plans" background="gray" narrow={width < MarketingLayout.narrowBreakpoint}>
      <SectionHead tag={t('plans.tag')} title={t('plans.title')} body={t('plans.lede')} width={width} />
      <View style={gridRowStyle(GUTTER)}>
        {PLANS.map((plan) => (
          <View key={plan.key} style={gridCellStyle(columns, GUTTER)}>
            <View style={[styles.plan, plan.featured && styles.planFeatured]}>
              {plan.featured && (
                <View style={styles.badge}>
                  <Text style={styles.badgeText}>{t('plans.mostPopular')}</Text>
                </View>
              )}
              <Text style={styles.name}>{t(plan.name)}</Text>
              <Text style={styles.for}>{t(plan.for)}</Text>

              <View style={styles.priceSlot}>
                <Text style={styles.priceSoon}>{t(plan.price)}</Text>
                <Text style={styles.priceNote}>{t(plan.priceNote)}</Text>
              </View>

              <View style={styles.features}>
                {plan.features.map((feature) => (
                  <View key={feature} style={styles.feature}>
                    <Text style={styles.check}>✓</Text>
                    <Text style={styles.featureText}>{t(feature)}</Text>
                  </View>
                ))}
              </View>

              <Btn
                label={t(plan.cta)}
                variant={plan.featured ? 'primary' : 'ghost'}
                fullWidth
                onPress={() =>
                  plan.action.kind === 'signup'
                    ? router.push('/signup')
                    : openExternalUrl(`mailto:${SUPPORT_EMAIL}`)
                }
              />
            </View>
          </View>
        ))}
      </View>
    </LandingSection>
  );
}

const styles = StyleSheet.create({
  plan: {
    height: '100%',
    backgroundColor: Marketing.white,
    borderWidth: 1,
    borderColor: Marketing.line,
    borderRadius: MarketingRadius.lg,
    paddingVertical: 30,
    paddingHorizontal: 24,
  },
  // 2px border rather than an outline, and the extra pixel is absorbed by the
  // padding so the featured card doesn't sit 2px taller than its neighbours.
  planFeatured: { borderWidth: 2, borderColor: Marketing.ink, paddingVertical: 29, paddingHorizontal: 23, ...MarketingShadowLg },

  badge: {
    position: 'absolute',
    top: -13,
    alignSelf: 'center',
    backgroundColor: Marketing.ink,
    borderRadius: MarketingRadius.pill,
    paddingVertical: 6,
    paddingHorizontal: 16,
  },
  badgeText: {
    color: Marketing.white,
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
  },

  name: { fontSize: 21, fontWeight: '800', color: Marketing.ink, marginBottom: 6 },
  for: { color: Marketing.gray500, fontSize: 14, lineHeight: 21, minHeight: 42 },

  priceSlot: {
    marginVertical: 22,
    paddingVertical: 16,
    paddingHorizontal: 18,
    backgroundColor: Marketing.gray50,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: Marketing.gray200,
    borderRadius: 14,
    alignItems: 'center',
  },
  priceSoon: { fontSize: 15, fontWeight: '800', color: Marketing.ink, textAlign: 'center' },
  priceNote: { fontSize: 12.5, color: Marketing.gray500, marginTop: 3, textAlign: 'center' },

  features: { marginBottom: 22 },
  feature: { flexDirection: 'row', gap: 11, paddingVertical: 8, alignItems: 'flex-start' },
  check: { color: Marketing.brand, fontWeight: '800', fontSize: 14.5 },
  featureText: { flex: 1, fontSize: 14.5, lineHeight: 21, color: Marketing.gray700 },
});
