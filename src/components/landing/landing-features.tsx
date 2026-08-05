import { StyleSheet, Text, useWindowDimensions, View } from 'react-native';

import { LandingSection } from '@/components/landing/landing-section';
import { Card, SectionHead, gridCellStyle, gridRowStyle } from '@/components/landing/landing-ui';
import { Marketing, MarketingLayout } from '@/constants/marketing-theme';
import { useLocale } from '@/hooks/use-locale';
import type { MessageKey } from '@/lib/i18n';

// Nine feature cards.
//
// Note the ninth: the design's original was "Works when the internet doesn't",
// which the product does not do — there is no offline queue, cache or service
// worker, and every write goes straight to Supabase. It was replaced with
// multi-branch, which is real (lib/locations.ts, stock-transfer-modal.tsx).

const FEATURES: { key: string; icon: string; tint: string; title: MessageKey; body: MessageKey }[] = [
  { key: 'pos', icon: '⚡', tint: Marketing.brandSoft, title: 'features.pos.title', body: 'features.pos.body' },
  { key: 'stock', icon: '📦', tint: Marketing.blueSoft, title: 'features.stock.title', body: 'features.stock.body' },
  { key: 'profit', icon: '📊', tint: '#F5F0FF', title: 'features.profit.title', body: 'features.profit.body' },
  { key: 'money', icon: '📱', tint: Marketing.amberSoft, title: 'features.money.title', body: 'features.money.body' },
  { key: 'discounts', icon: '🏷️', tint: '#FFF1F2', title: 'features.discounts.title', body: 'features.discounts.body' },
  { key: 'staff', icon: '👥', tint: Marketing.brandSoft, title: 'features.staff.title', body: 'features.staff.body' },
  { key: 'receipts', icon: '🧾', tint: Marketing.blueSoft, title: 'features.receipts.title', body: 'features.receipts.body' },
  { key: 'customers', icon: '👤', tint: '#F5F0FF', title: 'features.customers.title', body: 'features.customers.body' },
  { key: 'branches', icon: '🏬', tint: Marketing.amberSoft, title: 'features.branches.title', body: 'features.branches.body' },
];

const GUTTER = 22;

export function LandingFeatures() {
  const { t } = useLocale();
  const { width } = useWindowDimensions();
  const columns = width >= MarketingLayout.compactBreakpoint ? 3 : 1;

  return (
    <LandingSection id="features" narrow={width < MarketingLayout.narrowBreakpoint}>
      <SectionHead tag={t('features.tag')} title={t('features.title')} body={t('features.lede')} width={width} />
      <View style={gridRowStyle(GUTTER)}>
        {FEATURES.map((feature) => (
          <View key={feature.key} style={gridCellStyle(columns, GUTTER)}>
            {/* Not a Pressable: these do nothing when tapped. The design's
                hover-lift is dropped rather than wrapping nine static cards in
                a press target that screen readers would announce. */}
            <Card style={styles.card}>
              <View style={[styles.icon, { backgroundColor: feature.tint }]}>
                <Text style={styles.iconGlyph}>{feature.icon}</Text>
              </View>
              <Text style={styles.title}>{t(feature.title)}</Text>
              <Text style={styles.body}>{t(feature.body)}</Text>
            </Card>
          </View>
        ))}
      </View>
    </LandingSection>
  );
}

const styles = StyleSheet.create({
  card: { height: '100%' },
  icon: { width: 48, height: 48, borderRadius: 14, alignItems: 'center', justifyContent: 'center', marginBottom: 18 },
  iconGlyph: { fontSize: 22 },
  title: { fontSize: 17.5, fontWeight: '800', letterSpacing: -0.3, color: Marketing.ink, marginBottom: 8 },
  body: { fontSize: 14.5, lineHeight: 22, color: Marketing.gray500 },
});
