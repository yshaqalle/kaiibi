import { StyleSheet, Text, useWindowDimensions, View } from 'react-native';

import { LandingSection } from '@/components/landing/landing-section';
import { Card, SectionHead, gridCellStyle, gridRowStyle } from '@/components/landing/landing-ui';
import { Marketing, MarketingLayout } from '@/constants/marketing-theme';
import { useLocale } from '@/hooks/use-locale';
import type { MessageKey } from '@/lib/i18n';

// Three setup steps. Numbered because these genuinely are a sequence — you
// cannot add products before the shop exists — not for decoration.

const STEPS: { n: string; title: MessageKey; body: MessageKey }[] = [
  { n: '1', title: 'how.step1.title', body: 'how.step1.body' },
  { n: '2', title: 'how.step2.title', body: 'how.step2.body' },
  { n: '3', title: 'how.step3.title', body: 'how.step3.body' },
];

const GUTTER = 26;

export function LandingHow() {
  const { t } = useLocale();
  const { width } = useWindowDimensions();
  const columns = width >= MarketingLayout.compactBreakpoint ? 3 : 1;

  return (
    <LandingSection id="how" background="gray" narrow={width < MarketingLayout.narrowBreakpoint}>
      <SectionHead tag={t('how.tag')} title={t('how.title')} body={t('how.lede')} width={width} />
      <View style={gridRowStyle(GUTTER)}>
        {STEPS.map((step) => (
          <View key={step.n} style={gridCellStyle(columns, GUTTER)}>
            <Card style={styles.card}>
              <View style={styles.badge}>
                <Text style={styles.badgeText}>{step.n}</Text>
              </View>
              <Text style={styles.title}>{t(step.title)}</Text>
              <Text style={styles.body}>{t(step.body)}</Text>
            </Card>
          </View>
        ))}
      </View>
    </LandingSection>
  );
}

const styles = StyleSheet.create({
  card: { height: '100%', padding: 30 },
  badge: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: Marketing.ink,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 18,
  },
  badgeText: { color: Marketing.white, fontWeight: '800', fontSize: 16 },
  title: { fontSize: 18, fontWeight: '800', color: Marketing.ink, marginBottom: 8 },
  body: { fontSize: 14.5, lineHeight: 22, color: Marketing.gray500 },
});
