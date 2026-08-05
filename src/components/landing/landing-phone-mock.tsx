import { StyleSheet, Text, View } from 'react-native';

import { LandingDonut } from '@/components/landing/landing-donut';
import { Marketing, MarketingRadius, MarketingShadowLg } from '@/constants/marketing-theme';
import { useLocale } from '@/hooks/use-locale';

// The hero's phone, showing a shop's day. An illustration, not a live preview:
// every figure is fixed, and the section caption on the dashboard preview below
// says so in as many words. Replaces components/pos-preview-mock.tsx as the
// hero visual.
//
// Bars and rings are plain Views with percentage heights rather than a chart
// library — the shapes never change, so a real chart would be machinery for
// nothing.

const BAR_HEIGHTS = ['38%', '62%', '45%', '70%', '54%', '76%', '92%'] as const;

export function LandingPhoneMock() {
  const { t } = useLocale();

  return (
    <View style={styles.phone}>
      <View style={styles.inner}>
        <View style={styles.top}>
          <View style={styles.topRow}>
            <Text style={styles.topLabel}>{t('phone.takings')}</Text>
            <Text style={styles.topLabel}>•••</Text>
          </View>
          <Text style={styles.amount}>$284.50</Text>
          <Text style={styles.amountSub}>{t('phone.salesMeta')}</Text>
        </View>

        <View style={styles.body}>
          <View style={styles.bars}>
            {BAR_HEIGHTS.map((height, index) => (
              <View
                key={height + String(index)}
                style={[
                  styles.bar,
                  { height },
                  index === BAR_HEIGHTS.length - 1 && styles.barActive,
                ]}
              />
            ))}
          </View>

          <View style={styles.kpis}>
            <Kpi label={t('phone.profitWeek')} value="$262.20" />
            <Kpi label={t('phone.netMargin')} value="20%" />
          </View>

          <Text style={styles.sectionLabel}>{t('phone.paymentMethods')}</Text>
          <PayRow icon="💵" name={t('phone.cash')} meta={t('phone.sales7')} amount="$164.50" />
          <PayRow icon="📱" name="ZAAD" meta={t('phone.sales3')} amount="$85.00" />
          <PayRow icon="📱" name="e-Dahab" meta={t('phone.sales2')} amount="$35.00" last />

          <View style={styles.goal}>
            <LandingDonut size={44} percent={86} strokeWidth={12} fontSize={22} />
            <View style={styles.goalText}>
              <Text style={styles.goalAmount}>$1,284.50</Text>
              <Text style={styles.goalOf}>{t('phone.goalOf')}</Text>
            </View>
          </View>

          <View style={styles.insight}>
            <Text style={styles.insightText}>{t('phone.insight')}</Text>
          </View>

          <View style={styles.cta}>
            <Text style={styles.ctaText}>{t('phone.newSale')}</Text>
          </View>
        </View>
      </View>
    </View>
  );
}

function Kpi({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.kpi}>
      <Text style={styles.kpiLabel}>{label}</Text>
      <Text style={styles.kpiValue}>{value}</Text>
    </View>
  );
}

function PayRow({
  icon,
  name,
  meta,
  amount,
  last,
}: {
  icon: string;
  name: string;
  meta: string;
  amount: string;
  last?: boolean;
}) {
  return (
    <View style={[styles.payRow, last && styles.payRowLast]}>
      <View style={styles.payIcon}>
        <Text style={styles.payIconGlyph}>{icon}</Text>
      </View>
      <View style={styles.payName}>
        <Text style={styles.payNameText}>{name}</Text>
        <Text style={styles.payMeta}>{meta}</Text>
      </View>
      <Text style={styles.payAmount}>{amount}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  phone: {
    backgroundColor: Marketing.ink,
    borderRadius: 36,
    padding: 11,
    maxWidth: 330,
    width: '100%',
    ...MarketingShadowLg,
  },
  inner: { backgroundColor: Marketing.white, borderRadius: 27, overflow: 'hidden' },

  top: { backgroundColor: Marketing.ink, paddingHorizontal: 16, paddingTop: 14, paddingBottom: 16 },
  topRow: { flexDirection: 'row', justifyContent: 'space-between' },
  topLabel: { color: 'rgba(255,255,255,0.6)', fontSize: 10.5 },
  amount: { color: Marketing.white, fontSize: 26, fontWeight: '800', letterSpacing: -0.5, marginTop: 8 },
  amountSub: { color: 'rgba(255,255,255,0.65)', fontSize: 11 },

  body: { paddingHorizontal: 16, paddingTop: 14, paddingBottom: 18 },

  bars: { flexDirection: 'row', alignItems: 'flex-end', gap: 5, height: 56, marginTop: 12, marginBottom: 4 },
  bar: { flex: 1, backgroundColor: Marketing.gray200, borderRadius: 3 },
  barActive: { backgroundColor: Marketing.blue },

  kpis: { flexDirection: 'row', gap: 8, marginBottom: 12 },
  kpi: {
    flex: 1,
    backgroundColor: Marketing.gray50,
    borderWidth: 1,
    borderColor: Marketing.line,
    borderRadius: 12,
    paddingVertical: 9,
    paddingHorizontal: 10,
  },
  kpiLabel: {
    fontSize: 8.5,
    fontWeight: '700',
    color: Marketing.gray400,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  kpiValue: { fontSize: 14.5, fontWeight: '800', color: Marketing.brand, marginTop: 3, letterSpacing: -0.3 },

  sectionLabel: {
    fontSize: 10,
    fontWeight: '800',
    color: Marketing.gray400,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    marginTop: 14,
    marginBottom: 4,
  },

  payRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 9,
    borderBottomWidth: 1,
    borderBottomColor: Marketing.gray100,
  },
  payRowLast: { borderBottomWidth: 0 },
  payIcon: {
    width: 32,
    height: 32,
    borderRadius: 9,
    backgroundColor: Marketing.gray100,
    alignItems: 'center',
    justifyContent: 'center',
  },
  payIconGlyph: { fontSize: 14 },
  payName: { flex: 1 },
  payNameText: { fontSize: 12.5, fontWeight: '700', color: Marketing.ink },
  payMeta: { fontSize: 10.5, color: Marketing.gray400, fontWeight: '500' },
  payAmount: { fontSize: 12.5, fontWeight: '800', color: Marketing.ink },

  goal: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 11,
    backgroundColor: Marketing.gray50,
    borderWidth: 1,
    borderColor: Marketing.line,
    borderRadius: 12,
    padding: 10,
    marginTop: 12,
  },
  goalText: { flex: 1 },
  goalAmount: { fontSize: 13.5, fontWeight: '800', color: Marketing.ink },
  goalOf: { fontSize: 9.5, color: Marketing.gray400, marginTop: 1 },

  insight: {
    backgroundColor: Marketing.brandSoft,
    borderWidth: 1,
    borderColor: Marketing.brandBorder,
    borderRadius: 11,
    paddingVertical: 9,
    paddingHorizontal: 11,
    marginTop: 12,
  },
  insightText: { fontSize: 9.5, lineHeight: 14, color: Marketing.brandInk },

  cta: {
    marginTop: 12,
    backgroundColor: Marketing.ink,
    borderRadius: MarketingRadius.sm + 2,
    paddingVertical: 11,
    alignItems: 'center',
  },
  ctaText: { color: Marketing.white, fontSize: 12.5, fontWeight: '700' },
});
