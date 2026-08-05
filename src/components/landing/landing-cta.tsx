import { useRouter } from 'expo-router';
import { StyleSheet, Text, useWindowDimensions, View } from 'react-native';

import { LandingSection } from '@/components/landing/landing-section';
import { Btn } from '@/components/landing/landing-ui';
import { SUPPORT_EMAIL } from '@/constants/contact';
import { Marketing, MarketingLayout } from '@/constants/marketing-theme';
import { useAuth } from '@/hooks/use-auth';
import { useLocale } from '@/hooks/use-locale';
import { openExternalUrl } from '@/lib/external-url';
import { FONT_SCALE } from '@/lib/clamp-font';

// The closing band. Its section id is `download` because that is what the
// design's own "Get started free" links point at.
export function LandingCta() {
  const router = useRouter();
  const { t } = useLocale();
  const { session } = useAuth();
  const { width } = useWindowDimensions();
  const narrow = width < MarketingLayout.narrowBreakpoint;

  return (
    <LandingSection id="download" background="ink" narrow={narrow}>
      <View style={styles.inner}>
        <Text style={[styles.title, { fontSize: FONT_SCALE.h2(width) }]}>{t('cta.title')}</Text>
        <Text style={styles.lede}>{t('cta.lede')}</Text>
        <View style={[styles.buttons, narrow && styles.buttonsStacked]}>
          <Btn
            label={session ? t('hero.ctaDashboard') : t('cta.primary')}
            variant="white"
            size="lg"
            fullWidth={narrow}
            onPress={() => router.push(session ? '/dashboard' : '/signup')}
          />
          {/* Email, not WhatsApp: no support number exists yet. See
              constants/contact.ts — this becomes a one-line change. */}
          <Btn
            label={t('cta.secondary')}
            variant="outlineLight"
            size="lg"
            fullWidth={narrow}
            onPress={() => openExternalUrl(`mailto:${SUPPORT_EMAIL}`)}
          />
        </View>
      </View>
    </LandingSection>
  );
}

const styles = StyleSheet.create({
  inner: { alignItems: 'center' },
  title: {
    color: Marketing.white,
    fontWeight: '800',
    letterSpacing: -1,
    lineHeight: 44,
    textAlign: 'center',
    marginBottom: 16,
  },
  lede: {
    color: 'rgba(255,255,255,0.65)',
    fontSize: 16.5,
    lineHeight: 26,
    maxWidth: 520,
    textAlign: 'center',
    marginBottom: 32,
  },
  buttons: { flexDirection: 'row', gap: 12, flexWrap: 'wrap', justifyContent: 'center' },
  // nowrap for the same reason as the hero's stacked CTAs — a wrapping column
  // sizes children to content, so they never reach full width.
  buttonsStacked: { flexDirection: 'column', flexWrap: 'nowrap', alignSelf: 'stretch', alignItems: 'stretch' },
});
