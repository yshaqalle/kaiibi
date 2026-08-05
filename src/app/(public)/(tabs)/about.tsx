import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { LandingFooter } from '@/components/landing/landing-footer';
import { useLocale } from '@/hooks/use-locale';
import type { MessageKey } from '@/lib/i18n';

// The "how it works" page. Shared web + native — on native it is a pushed
// screen off the login hero, which is why the footer it uses has to stay free
// of web-only APIs.
//
// Distinct from the landing page's `#how` band: that one is three steps to get
// selling, this is the longer setup walk-through the nav and footer point at.

const STEPS: { n: string; title: MessageKey; body: MessageKey }[] = [
  { n: '01', title: 'about.step1.title', body: 'about.step1.body' },
  { n: '02', title: 'about.step2.title', body: 'about.step2.body' },
  { n: '03', title: 'about.step3.title', body: 'about.step3.body' },
  { n: '04', title: 'about.step4.title', body: 'about.step4.body' },
];

export default function AboutScreen() {
  const { t } = useLocale();

  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView showsVerticalScrollIndicator={false}>
        <View style={styles.content}>
          <View style={styles.hero}>
            <Text style={styles.eyebrow}>{t('about.eyebrow').toUpperCase()}</Text>
            <Text style={styles.title}>{t('about.title')}</Text>
            <Text style={styles.intro}>{t('about.intro')}</Text>
          </View>

          <Text style={styles.sectionLabel}>{t('about.builtFor').toUpperCase()}</Text>
          <View style={styles.userCards}>
            <View style={[styles.userCard, styles.ownerCard]}>
              <Text style={styles.cardIcon}>▦</Text>
              <Text style={styles.cardTitle}>{t('about.owner.title')}</Text>
              <Text style={styles.cardText}>{t('about.owner.body')}</Text>
              <Text style={styles.cardNeed}>{t('about.owner.need')}</Text>
            </View>
          </View>

          <View style={styles.divider} />
          <Text style={styles.sectionLabel}>{t('about.gettingStarted').toUpperCase()}</Text>
          <Text style={styles.sectionTitle}>{t('about.stepsTitle')}</Text>
          <View style={styles.steps}>
            {STEPS.map((step) => (
              <View key={step.n} style={styles.step}>
                <Text style={styles.stepNumber}>{step.n}</Text>
                <View style={styles.stepCopy}>
                  <Text style={styles.stepTitle}>{t(step.title)}</Text>
                  <Text style={styles.stepText}>{t(step.body)}</Text>
                </View>
              </View>
            ))}
          </View>

          <View style={styles.mission}>
            <Text style={styles.missionLabel}>{t('about.mission.tag').toUpperCase()}</Text>
            <Text style={styles.missionTitle}>{t('about.mission.title')}</Text>
            <Text style={styles.missionText}>{t('about.mission.body')}</Text>
          </View>
        </View>

        <LandingFooter />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#FFFFFF' },
  content: { width: '100%', maxWidth: 900, alignSelf: 'center', paddingHorizontal: 20, paddingVertical: 30, paddingBottom: 40 },
  hero: { backgroundColor: '#F2F2F2', borderRadius: 22, padding: 28 },
  eyebrow: { color: '#999999', letterSpacing: 1.2, fontSize: 10, fontWeight: '800' },
  title: { color: '#111111', fontSize: 35, lineHeight: 39, letterSpacing: -1.8, fontWeight: '800', marginTop: 10, maxWidth: 620 },
  intro: { color: '#666666', fontSize: 15, lineHeight: 22, marginTop: 15, maxWidth: 570 },
  sectionLabel: { color: '#999999', letterSpacing: 1.25, fontSize: 10, fontWeight: '800', marginTop: 34, marginBottom: 8 },
  userCards: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  userCard: { flexGrow: 1, flexBasis: 280, minHeight: 160, borderRadius: 17, padding: 20 },
  ownerCard: { backgroundColor: '#F2F2F2' },
  cardIcon: { color: '#111111', fontSize: 25, fontWeight: '800' },
  cardTitle: { color: '#111111', fontSize: 21, fontWeight: '800', letterSpacing: -0.6, marginTop: 10 },
  cardText: { color: '#666666', fontSize: 13, lineHeight: 19, marginTop: 7 },
  cardNeed: { color: '#111111', fontSize: 12, lineHeight: 17, fontWeight: '800', marginTop: 14 },
  divider: { height: 1, backgroundColor: '#ECECEC', marginTop: 34 },
  sectionTitle: { color: '#111111', fontSize: 26, lineHeight: 30, letterSpacing: -1, fontWeight: '800', maxWidth: 520 },
  steps: { marginTop: 22 },
  step: { flexDirection: 'row', paddingVertical: 17, borderTopWidth: 1, borderTopColor: '#ECECEC' },
  stepNumber: { width: 48, color: '#999999', fontSize: 12, letterSpacing: 0.8, fontWeight: '800', paddingTop: 3 },
  stepCopy: { flex: 1 },
  stepTitle: { color: '#111111', fontSize: 17, fontWeight: '800' },
  stepText: { color: '#666666', fontSize: 13, lineHeight: 19, marginTop: 5, maxWidth: 560 },
  mission: { backgroundColor: '#111111', borderRadius: 19, padding: 23, marginTop: 35 },
  missionLabel: { color: '#CCCCCC', fontSize: 10, fontWeight: '800', letterSpacing: 1.2 },
  missionTitle: { color: '#FFFFFF', fontSize: 24, letterSpacing: -0.8, fontWeight: '800', marginTop: 8 },
  missionText: { color: '#CCCCCC', fontSize: 13, lineHeight: 20, marginTop: 8, maxWidth: 580 },
});
