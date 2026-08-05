import { useRouter } from 'expo-router';
import { StyleSheet, Text, useWindowDimensions, View } from 'react-native';

import { LandingPhoneMock } from '@/components/landing/landing-phone-mock';
import { Btn } from '@/components/landing/landing-ui';
import { Marketing, MarketingLayout, MarketingRadius, MarketingShadow } from '@/constants/marketing-theme';
import { useAuth } from '@/hooks/use-auth';
import { useLocale } from '@/hooks/use-locale';
import { useSectionScroll } from '@/hooks/use-section-scroll';
import { FONT_SCALE } from '@/lib/clamp-font';
import { webDataAttr } from '@/lib/web-data-attr';

export function LandingHero() {
  const router = useRouter();
  const { t } = useLocale();
  const { session } = useAuth();
  const { scrollToSection } = useSectionScroll();
  const { width } = useWindowDimensions();

  const desktop = width >= MarketingLayout.compactBreakpoint;
  const titleSize = FONT_SCALE.h1(width);

  return (
    <View style={[styles.hero, !desktop && styles.heroNarrow]} {...webDataAttr('hero-bg')}>
      <View style={[styles.wrap, desktop && styles.wrapDesktop]}>
        <View style={[styles.copy, desktop && styles.copyDesktop]}>
          <View style={styles.eyebrow}>
            <View style={styles.eyebrowDot} />
            <Text style={styles.eyebrowText}>{t('hero.eyebrow')}</Text>
          </View>

          {/* Three spans rather than one string: the middle one carries the
              green underline, and Somali reorders them ("Nidaamka iibka ee
              loogu talagalay / ganacsigaaga / nooca aad leedahay"), so they
              have to be separately translatable. */}
          <Text style={[styles.title, { fontSize: titleSize, lineHeight: titleSize * 1.08 }]}>
            {t('hero.title1')} <Highlight text={t('hero.title2')} /> {t('hero.title3')}
          </Text>

          <Text style={styles.lede}>{t('hero.lede')}</Text>

          <View style={[styles.ctaRow, !desktop && styles.ctaRowNarrow]}>
            <Btn
              label={session ? t('hero.ctaDashboard') : t('hero.ctaPrimary')}
              size="lg"
              fullWidth={!desktop}
              onPress={() => router.push(session ? '/dashboard' : '/signup')}
            />
            <Btn
              label={t('hero.ctaSecondary')}
              variant="ghost"
              size="lg"
              fullWidth={!desktop}
              onPress={() => scrollToSection('how')}
            />
          </View>

          <View style={[styles.notes, !desktop && styles.notesNarrow]}>
            <Note label={t('hero.note1')} />
            <Note label={t('hero.note2')} />
            <Note label={t('hero.note3')} />
          </View>
        </View>

        <View style={[styles.visual, desktop && styles.visualDesktop]}>
          <LandingPhoneMock />
        </View>
      </View>
    </View>
  );
}

// The design puts a translucent green bar behind one word. RN cannot stack an
// absolutely positioned View behind inline text, so this is a nested Text with
// a background — a highlighter rather than a rule.
//
// Tried and rejected: `borderBottomWidth`. It renders below the descender line
// with a visible gap and overshoots the word's right edge, which reads as a
// layout bug rather than emphasis. A background also survives a line wrap,
// which an absolutely positioned bar would not.
function Highlight({ text }: { text: string }) {
  return <Text style={styles.highlight}>{text}</Text>;
}

function Note({ label }: { label: string }) {
  return (
    <View style={styles.note}>
      <Text style={styles.noteTick}>✓</Text>
      <Text style={styles.noteText}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  hero: { paddingTop: 82, paddingBottom: 70, backgroundColor: Marketing.white },
  heroNarrow: { paddingTop: 52, paddingBottom: 50 },
  wrap: {
    width: '100%',
    maxWidth: MarketingLayout.maxWidth,
    alignSelf: 'center',
    paddingHorizontal: MarketingLayout.gutter,
    gap: 44,
  },
  wrapDesktop: { flexDirection: 'row', alignItems: 'center', gap: 56 },

  copy: {},
  copyDesktop: { flex: 1.05, maxWidth: 560 },

  eyebrow: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: Marketing.white,
    borderWidth: 1,
    borderColor: Marketing.line,
    borderRadius: MarketingRadius.pill,
    paddingVertical: 7,
    paddingHorizontal: 16,
    ...MarketingShadow,
  },
  eyebrowDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: Marketing.brand },
  eyebrowText: { fontSize: 12.5, fontWeight: '700', color: Marketing.gray700 },

  title: {
    letterSpacing: -1.6,
    fontWeight: '800',
    color: Marketing.ink,
    marginTop: 22,
    marginBottom: 18,
  },
  highlight: { color: Marketing.ink, backgroundColor: 'rgba(15,157,88,0.22)' },

  lede: { fontSize: 17.5, lineHeight: 28, color: Marketing.gray500, maxWidth: 520 },

  ctaRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 12, marginTop: 30, marginBottom: 22 },
  // flexWrap must go back to nowrap here. A wrapping column sizes its children
  // to their content, so `alignItems: 'stretch'` silently did nothing and the
  // stacked buttons came out at text width instead of full bleed.
  ctaRowNarrow: { flexDirection: 'column', flexWrap: 'nowrap', alignItems: 'stretch' },

  notes: { flexDirection: 'row', flexWrap: 'wrap', gap: 20 },
  notesNarrow: { flexDirection: 'column', gap: 7 },
  note: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  noteTick: { color: Marketing.brand, fontWeight: '800', fontSize: 13.5 },
  noteText: { fontSize: 13.5, color: Marketing.gray500, fontWeight: '600' },

  visual: { alignItems: 'center' },
  visualDesktop: { flex: 0.95 },
});
