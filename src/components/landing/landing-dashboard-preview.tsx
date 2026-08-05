import { StyleSheet, Text, useWindowDimensions, View, type DimensionValue, type ViewStyle } from 'react-native';

import { LandingDonut } from '@/components/landing/landing-donut';
import { LandingRevenueChart } from '@/components/landing/landing-revenue-chart';
import { LandingSection } from '@/components/landing/landing-section';
import { SectionHead } from '@/components/landing/landing-ui';
import { Marketing, MarketingLayout, MarketingShadowLg } from '@/constants/marketing-theme';
import { useLocale } from '@/hooks/use-locale';

// A browser frame around a stylised dashboard.
//
// Every figure is invented. The design's caption used to read "Real figures
// from a Kaiibi shop", which was a claim we cannot make — it now says sample
// data, and the strings say so in both languages.

const GUTTER = 12;

// The design's 12-column spans, as widths per breakpoint. RN has no grid, so
// each card states what fraction of the row it takes at wide / medium / narrow.
type Span = 'd3' | 'd4' | 'd5' | 'd7';
const SPANS: Record<Span, [DimensionValue, DimensionValue, DimensionValue]> = {
  d3: ['25%', '50%', '100%'],
  d4: ['33.333%', '100%', '100%'],
  d5: ['41.667%', '100%', '100%'],
  d7: ['58.333%', '100%', '100%'],
};

export function LandingDashboardPreview() {
  const { t } = useLocale();
  const { width } = useWindowDimensions();
  const tier = width >= 1050 ? 0 : width >= MarketingLayout.narrowBreakpoint ? 1 : 2;
  const cell = (span: Span): ViewStyle => ({
    width: SPANS[span][tier],
    paddingHorizontal: GUTTER / 2,
    paddingBottom: GUTTER,
  });

  return (
    <LandingSection id="dashboard" background="gray" narrow={width < MarketingLayout.narrowBreakpoint}>
      <SectionHead tag={t('dash.tag')} title={t('dash.title')} body={t('dash.lede')} width={width} />

      <View style={styles.browser}>
        <View style={styles.browserBar}>
          <View style={styles.dots}>
            <View style={styles.dot} />
            <View style={styles.dot} />
            <View style={styles.dot} />
          </View>
          <View style={styles.url}>
            <Text style={styles.urlText}>app.kaiibi.com</Text>
          </View>
          {/* Balances the dots so the url pill sits centred. */}
          <View style={styles.dots} />
        </View>

        <View style={[styles.dash, width < MarketingLayout.narrowBreakpoint && styles.dashNarrow]}>
          <View style={styles.dashTop}>
            <View style={styles.hello}>
              <Text style={styles.helloTitle}>{t('dash.greeting')}</Text>
              <Text style={styles.helloSub}>{t('dash.greetingSub')}</Text>
            </View>
            <View style={styles.chip}>
              <Text style={styles.chipText}>{t('dash.range')} ⌄</Text>
            </View>
          </View>

          <View style={styles.grid}>
            <View style={cell('d3')}>
              <Kpi label={t('dash.revenue')} value="$1,284.50" hint={t('dash.revenueHint')} />
            </View>
            <View style={cell('d3')}>
              <Kpi label={t('dash.expenses')} value="$310.00" hint={t('dash.expensesHint')} />
            </View>
            <View style={cell('d3')}>
              <Kpi label={t('dash.netProfit')} value="$262.20" hint={t('dash.netProfitHint')} green />
            </View>
            <View style={cell('d3')}>
              <Kpi label={t('dash.orders')} value="42" hint={t('dash.ordersHint')} />
            </View>

            <View style={cell('d7')}>
              <View style={styles.card}>
                <Text style={styles.cardTitle}>{t('dash.revenueWeek')}</Text>
                <LandingRevenueChart />
              </View>
            </View>

            <View style={cell('d5')}>
              <View style={styles.card}>
                <Text style={styles.cardTitle}>{t('dash.paymentMethods')}</Text>
                <PayBar icon="💵" name={t('dash.cash')} amount="$784.50" pct={61} color={Marketing.blue} />
                <PayBar icon="📱" name="ZAAD" amount="$340.00" pct={26} color={Marketing.purple} />
                <PayBar icon="📱" name="e-Dahab" amount="$160.00" pct={12} color={Marketing.teal} />
              </View>
            </View>

            <View style={cell('d4')}>
              <View style={styles.card}>
                <Text style={styles.cardTitle}>{t('dash.pnl')}</Text>
                <PnlRow label={t('dash.pnlRevenue')} value="$1,284.50" />
                <PnlRow label={t('dash.pnlCogs')} value="-$712.30" />
                <PnlRow label={t('dash.pnlGross')} value="$572.20" />
                <PnlRow label={t('dash.pnlOpex')} value="-$310.00" />
                <PnlRow label={t('dash.pnlNet')} value="$262.20" green last />
              </View>
            </View>

            <View style={cell('d4')}>
              <View style={styles.card}>
                <Text style={styles.cardTitle}>{t('dash.goal')}</Text>
                <View style={styles.goalRow}>
                  <LandingDonut size={74} percent={86} strokeWidth={11} fontSize={19} trackColor="#EEF0F4" />
                  <View style={styles.goalText}>
                    <Text style={styles.goalAmount}>$1,284.50</Text>
                    <Text style={styles.hint}>{t('dash.goalOf')}</Text>
                  </View>
                </View>
              </View>
            </View>

            <View style={cell('d4')}>
              <View style={styles.card}>
                <Text style={styles.cardTitle}>{t('dash.worthKnowing')}</Text>
                <View style={styles.insight}>
                  <Text style={styles.insightText}>{t('dash.insight')}</Text>
                </View>
              </View>
            </View>
          </View>
        </View>
      </View>

      <Text style={styles.caption}>{t('dash.caption')}</Text>
    </LandingSection>
  );
}

function Kpi({ label, value, hint, green }: { label: string; value: string; hint: string; green?: boolean }) {
  return (
    <View style={styles.card}>
      <Text style={styles.kpiLabel}>{label}</Text>
      <Text style={[styles.kpiValue, green && styles.green]}>{value}</Text>
      <Text style={styles.hint}>{hint}</Text>
    </View>
  );
}

function PayBar({
  icon,
  name,
  amount,
  pct,
  color,
}: {
  icon: string;
  name: string;
  amount: string;
  pct: number;
  color: string;
}) {
  return (
    <View style={styles.payRow}>
      <View style={styles.payIcon}>
        <Text style={styles.payIconGlyph}>{icon}</Text>
      </View>
      <View style={styles.payBody}>
        <View style={styles.payTop}>
          <Text style={styles.payName}>{name}</Text>
          <Text style={styles.payAmount}>{amount}</Text>
        </View>
        <View style={styles.track}>
          <View style={[styles.fill, { width: `${pct}%`, backgroundColor: color }]} />
        </View>
      </View>
    </View>
  );
}

function PnlRow({ label, value, green, last }: { label: string; value: string; green?: boolean; last?: boolean }) {
  return (
    <View style={[styles.pnlRow, last && styles.pnlRowLast]}>
      <Text style={styles.pnlLabel}>{label}</Text>
      <Text style={[styles.pnlValue, green && styles.green]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  browser: {
    backgroundColor: Marketing.white,
    borderWidth: 1,
    borderColor: Marketing.line,
    borderRadius: 20,
    overflow: 'hidden',
    ...MarketingShadowLg,
  },
  browserBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 12,
    paddingHorizontal: 16,
    backgroundColor: Marketing.gray50,
    borderBottomWidth: 1,
    borderBottomColor: Marketing.line,
  },
  dots: { flexDirection: 'row', gap: 6, width: 45 },
  dot: { width: 11, height: 11, borderRadius: 6, backgroundColor: Marketing.gray200 },
  url: {
    flex: 1,
    maxWidth: 280,
    alignSelf: 'center',
    marginHorizontal: 'auto',
    backgroundColor: Marketing.white,
    borderWidth: 1,
    borderColor: Marketing.line,
    borderRadius: 999,
    paddingVertical: 5,
    paddingHorizontal: 14,
  },
  urlText: { fontSize: 12, color: Marketing.gray400, textAlign: 'center' },

  dash: { padding: 20, backgroundColor: '#FBFBFC' },
  dashNarrow: { padding: 12 },
  dashTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    marginBottom: 16,
    flexWrap: 'wrap',
  },
  hello: { flexShrink: 1 },
  helloTitle: { fontSize: 15, fontWeight: '800', color: Marketing.ink },
  helloSub: { fontSize: 12, color: Marketing.gray500, marginTop: 2 },
  chip: {
    borderWidth: 1,
    borderColor: Marketing.line,
    backgroundColor: Marketing.white,
    borderRadius: 999,
    paddingVertical: 6,
    paddingHorizontal: 13,
  },
  chipText: { fontSize: 11.5, fontWeight: '700', color: Marketing.ink },

  grid: { flexDirection: 'row', flexWrap: 'wrap', marginHorizontal: -GUTTER / 2 },
  card: {
    height: '100%',
    backgroundColor: Marketing.white,
    borderWidth: 1,
    borderColor: Marketing.line,
    borderRadius: 16,
    padding: 15,
  },
  cardTitle: { fontSize: 12.5, fontWeight: '800', color: Marketing.ink, marginBottom: 10 },

  kpiLabel: {
    fontSize: 10.5,
    color: Marketing.gray400,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  kpiValue: { fontSize: 20, fontWeight: '800', color: Marketing.ink, marginTop: 5, letterSpacing: -0.5 },
  hint: { fontSize: 11, color: Marketing.gray400, marginTop: 2 },
  green: { color: Marketing.brand },

  payRow: { flexDirection: 'row', alignItems: 'center', gap: 9, paddingVertical: 6 },
  payIcon: {
    width: 26,
    height: 26,
    borderRadius: 8,
    backgroundColor: Marketing.gray100,
    alignItems: 'center',
    justifyContent: 'center',
  },
  payIconGlyph: { fontSize: 12 },
  payBody: { flex: 1 },
  payTop: { flexDirection: 'row', justifyContent: 'space-between', gap: 10 },
  payName: { fontSize: 12, fontWeight: '700', color: Marketing.ink },
  payAmount: { fontSize: 12, fontWeight: '800', color: Marketing.ink },
  track: { height: 5, borderRadius: 3, backgroundColor: Marketing.gray100, marginTop: 4, overflow: 'hidden' },
  fill: { height: '100%', borderRadius: 3 },

  pnlRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 10,
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderBottomColor: Marketing.gray100,
  },
  pnlRowLast: { borderBottomWidth: 0 },
  pnlLabel: { fontSize: 12, color: Marketing.ink, flexShrink: 1 },
  pnlValue: { fontSize: 12, fontWeight: '800', color: Marketing.ink },

  goalRow: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  goalText: { flexShrink: 1 },
  goalAmount: { fontSize: 17, fontWeight: '800', color: Marketing.ink, letterSpacing: -0.5 },

  insight: {
    backgroundColor: Marketing.brandSoft,
    borderWidth: 1,
    borderColor: Marketing.brandBorder,
    borderRadius: 12,
    paddingVertical: 11,
    paddingHorizontal: 13,
  },
  insightText: { fontSize: 11.5, lineHeight: 18, color: Marketing.brandInk },

  caption: { textAlign: 'center', fontSize: 13, color: Marketing.gray500, marginTop: 20 },
});
