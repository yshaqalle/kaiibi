import { StyleSheet, Text, useWindowDimensions, View } from 'react-native';

import { LandingSection } from '@/components/landing/landing-section';
import { Marketing, MarketingLayout } from '@/constants/marketing-theme';
import { useLocale } from '@/hooks/use-locale';
import { FONT_SCALE } from '@/lib/clamp-font';
import type { MessageKey } from '@/lib/i18n';

// Four figures, all of them true.
//
// The design's original set claimed "100% — Works offline", which the product
// does not do, and "3 currencies", which understates it — `shop_currencies` is
// shop-defined and unbounded. Both were replaced rather than softened.

const STATS: { key: string; value: MessageKey; label: MessageKey }[] = [
  { key: 'currencies', value: 'stats.currencies.value', label: 'stats.currencies.label' },
  { key: 'methods', value: 'stats.methods.value', label: 'stats.methods.label' },
  { key: 'languages', value: 'stats.languages.value', label: 'stats.languages.label' },
  { key: 'cost', value: 'stats.cost.value', label: 'stats.cost.label' },
];

export function LandingStats() {
  const { t } = useLocale();
  const { width } = useWindowDimensions();
  const columns = width >= MarketingLayout.compactBreakpoint ? 4 : 2;
  const valueSize = FONT_SCALE.stat(width);

  return (
    <LandingSection background="ink" narrow={width < MarketingLayout.narrowBreakpoint}>
      <View style={styles.row}>
        {STATS.map((stat) => (
          <View key={stat.key} style={[styles.cell, { width: `${100 / columns}%` }]}>
            <Text style={[styles.value, { fontSize: valueSize, lineHeight: valueSize * 1.15 }]}>
              {t(stat.value)}
            </Text>
            <Text style={styles.label}>{t(stat.label)}</Text>
          </View>
        ))}
      </View>
    </LandingSection>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', flexWrap: 'wrap', marginHorizontal: -13 },
  cell: { paddingHorizontal: 13, paddingBottom: 26, alignItems: 'center' },
  value: { fontWeight: '800', letterSpacing: -1.2, color: Marketing.white, textAlign: 'center' },
  label: { fontSize: 13.5, color: 'rgba(255,255,255,0.6)', marginTop: 6, textAlign: 'center' },
});
