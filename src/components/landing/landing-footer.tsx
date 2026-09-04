import { useRouter } from 'expo-router';
import { Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';

import { KaiibiLockup } from '@/components/landing/landing-ui';
import { LanguageSwitch } from '@/components/landing/language-switch';
import { SUPPORT_EMAIL } from '@/constants/contact';
import { Marketing, MarketingLayout } from '@/constants/marketing-theme';
import { useLocale } from '@/hooks/use-locale';
import { useSectionScroll, type SectionId } from '@/hooks/use-section-scroll';
import { openExternalUrl } from '@/lib/external-url';
import type { MessageKey } from '@/lib/i18n';

// The public footer. Replaces the old components/public-footer.tsx.
//
// Kept free of web-only APIs on purpose: about.tsx is shared, and on native it
// is a pushed screen off the login hero — so this renders on a phone too. The
// section links no-op harmlessly there, since `scrollToSection` navigates to
// `/`, which on native redirects to `/login`.
//
// Two links the design carried are deliberately absent: "Help centre" (no such
// thing exists) and "Terms of service" (no route, and typedRoutes won't compile
// an Href for one). A footer link to a 404 is worse than a shorter column.

const PRODUCT_LINKS: { id: SectionId; key: MessageKey }[] = [
  { id: 'features', key: 'nav.features' },
  { id: 'plans', key: 'nav.plans' },
  { id: 'how', key: 'nav.how' },
];

export function LandingFooter() {
  const router = useRouter();
  const { t } = useLocale();
  const { scrollToSection } = useSectionScroll();
  const { width } = useWindowDimensions();
  const year = new Date().getFullYear();

  const stacked = width < MarketingLayout.narrowBreakpoint;
  const columns = width < MarketingLayout.compactBreakpoint ? 2 : 4;

  return (
    <View style={styles.footer}>
      <View style={styles.wrap}>
        <View style={[styles.grid, stacked && styles.gridStacked]}>
          <View style={[styles.brandCol, columns === 4 && styles.brandColWide]}>
            <Pressable onPress={() => router.push('/')} accessibilityRole="link">
              <KaiibiLockup tone="dark" />
            </Pressable>
            <Text style={styles.blurb}>{t('footer.blurb')}</Text>
          </View>

          <View style={styles.col}>
            <Text style={styles.colHead}>{t('footer.product')}</Text>
            {PRODUCT_LINKS.map((link) => (
              <FooterLink key={link.id} label={t(link.key)} onPress={() => scrollToSection(link.id)} />
            ))}
            {/* A ROUTE, not a section -- so `router.push`, never
                `scrollToSection`, which navigates to `/` and would take a
                reader away from the directory rather than to it. Unlike the two
                links this footer's header comment says are deliberately absent,
                this one has a real page behind it. */}
            <FooterLink label={t('nav.shops')} onPress={() => router.push('/store')} />
            <FooterLink label={t('footer.getStarted')} onPress={() => router.push('/signup')} />
          </View>

          <View style={styles.col}>
            <Text style={styles.colHead}>{t('footer.support')}</Text>
            <FooterLink label={t('nav.faq')} onPress={() => scrollToSection('faq')} />
            {/* Email rather than WhatsApp: there is no support number in the
                codebase yet. See constants/contact.ts. */}
            <FooterLink
              label={t('footer.emailUs')}
              onPress={() => openExternalUrl(`mailto:${SUPPORT_EMAIL}`)}
            />
          </View>

          <View style={styles.col}>
            <Text style={styles.colHead}>{t('footer.company')}</Text>
            <FooterLink label={t('footer.about')} onPress={() => router.push('/about')} />
            {/* /privacy/policy is the URL on file with App Store Connect and
                Google Play's Data Safety form — see the comment in that file
                before changing this path. */}
            <FooterLink label={t('footer.privacy')} onPress={() => router.push('/privacy/policy')} />
          </View>
        </View>

        <View style={[styles.bottom, stacked && styles.bottomStacked]}>
          <Text style={styles.copyright}>{t('footer.copyright', { year })}</Text>
          <View style={styles.langRow}>
            <Text style={styles.langLabel}>{t('lang.label')}</Text>
            <LanguageSwitch tone="onLight" />
          </View>
        </View>
      </View>
    </View>
  );
}

function FooterLink({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="link" style={styles.linkRow}>
      {({ hovered }) => <Text style={[styles.linkText, hovered && styles.linkTextHovered]}>{label}</Text>}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  footer: {
    backgroundColor: Marketing.gray50,
    borderTopWidth: 1,
    borderTopColor: Marketing.line,
    paddingTop: 64,
  },
  wrap: {
    width: '100%',
    maxWidth: MarketingLayout.maxWidth,
    alignSelf: 'center',
    paddingHorizontal: MarketingLayout.gutter,
  },

  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 40, paddingBottom: 44 },
  gridStacked: { flexDirection: 'column', gap: 26 },
  brandCol: { minWidth: 240, flexGrow: 1, flexBasis: 240 },
  brandColWide: { flexGrow: 2, flexBasis: 280 },
  blurb: { color: Marketing.gray500, fontSize: 14, lineHeight: 21, marginTop: 14, maxWidth: 280 },
  col: { minWidth: 130, flexGrow: 1, flexBasis: 130 },
  colHead: {
    fontSize: 12.5,
    fontWeight: '800',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    color: Marketing.gray400,
    marginBottom: 16,
  },

  linkRow: { paddingVertical: 5 },
  linkText: { color: Marketing.gray700, fontSize: 14.5 },
  linkTextHovered: { color: Marketing.ink },

  bottom: {
    borderTopWidth: 1,
    borderTopColor: Marketing.line,
    paddingVertical: 26,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
    gap: 18,
  },
  bottomStacked: { flexDirection: 'column', alignItems: 'flex-start' },
  copyright: { fontSize: 13.5, color: Marketing.gray500 },
  langRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  langLabel: { fontSize: 13.5, color: Marketing.gray500, fontWeight: '600' },
});
