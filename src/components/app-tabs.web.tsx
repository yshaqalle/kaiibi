import { useRouter } from 'expo-router';
import { Tabs, TabList, TabListProps, TabSlot, TabTrigger, TabTriggerSlotProps } from 'expo-router/ui';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';

import { KaiibiLockup } from '@/components/landing/landing-ui';
import { LanguageSwitch } from '@/components/landing/language-switch';
import { Marketing, MarketingLayout, MarketingRadius } from '@/constants/marketing-theme';
import { useAuth } from '@/hooks/use-auth';
import { useLocale } from '@/hooks/use-locale';
import { useSectionScroll, type SectionId } from '@/hooks/use-section-scroll';
import type { MessageKey } from '@/lib/i18n';
import { webDataAttr } from '@/lib/web-data-attr';

// The public web chrome: an ink language bar above a white nav.
//
// Owned by this layout rather than by the landing page, because it wraps all
// three public routes. A landing-only nav would leave /about and /signup on a
// different header — the two pages a converting visitor hits next — and would
// have to duplicate the TabTrigger wiring that (tabs)/_layout.tsx exists to
// keep in one place.
//
// The header is `position: absolute` OUTSIDE the scroller, which in RNW's
// full-height flex root behaves like `fixed`, with TabSlot given a matching
// paddingTop. That was already the approach here; what changed is that the
// padding is now MEASURED rather than the old hardcoded 62, because the header
// height is no longer fixed: the language bar wraps on narrow screens and the
// mobile menu opens beneath it.
//
// Deliberate difference from the design: the language bar stays pinned rather
// than scrolling away under the nav. Making only the nav sticky would mean
// moving the bar into each page's scroll content — below the nav, inverting
// the design's own order, and absent from /about and /signup entirely. The
// footer switcher covers the "I've scrolled past it" case.

const SECTION_LINKS: { id: SectionId; key: MessageKey }[] = [
  { id: 'dashboard', key: 'nav.dashboard' },
  { id: 'features', key: 'nav.features' },
  { id: 'how', key: 'nav.how' },
  { id: 'plans', key: 'nav.plans' },
  { id: 'faq', key: 'nav.faq' },
];

export default function AppTabs() {
  const { width } = useWindowDimensions();
  const compact = width < MarketingLayout.compactBreakpoint;
  const [menuOpen, setMenuOpen] = useState(false);
  // The WHOLE header, mobile menu included — this is what content must clear.
  // Distinct from the scroll anchor in useSectionScroll, which is only the part
  // that stays pinned; see setChromeHeight below.
  const [headerHeight, setHeaderHeight] = useState(108);

  return (
    <Tabs>
      <TabSlot style={[styles.slot, { paddingTop: headerHeight }]} />
      <TabList asChild>
        <Header
          compact={compact}
          menuOpen={menuOpen}
          onToggleMenu={() => setMenuOpen((open) => !open)}
          onCloseMenu={() => setMenuOpen(false)}
          onMeasure={setHeaderHeight}
        >
          {/* TabTriggers must be direct children of TabList, so the two that
              are real tabs are declared here and positioned by Header. */}
          <TabTrigger name="discover" href="/" asChild>
            <LogoLink />
          </TabTrigger>
          <TabTrigger name="signup" href="/signup" asChild>
            <SignUpButton />
          </TabTrigger>
          <TabTrigger name="about" href="/about" asChild>
            <HiddenTrigger />
          </TabTrigger>
        </Header>
      </TabList>
    </Tabs>
  );
}

function Header({
  compact,
  menuOpen,
  onToggleMenu,
  onCloseMenu,
  onMeasure,
  children,
  style,
  ...props
}: TabListProps & {
  compact: boolean;
  menuOpen: boolean;
  onToggleMenu: () => void;
  onCloseMenu: () => void;
  onMeasure: (height: number) => void;
}) {
  const { t } = useLocale();
  const { session } = useAuth();
  const childArray = Array.isArray(children) ? children : [children];
  const [logo, signUp] = childArray;

  return (
    <View
      {...props}
      onLayout={(event) => onMeasure(event.nativeEvent.layout.height)}
      // TabList's own style comes FIRST so ours wins. It ships a row
      // direction, which laid the language bar and the nav side by side
      // instead of stacking them.
      style={[style, styles.header]}
    >
      <View style={styles.langBar}>
        <View style={styles.langBarInner}>
          <Text style={styles.langBarText} numberOfLines={1}>
            {t(compact ? 'langbar.short' : 'langbar.tagline')}
          </Text>
          <LanguageSwitch tone="onDark" compact={compact} />
        </View>
      </View>

      {/* The blur itself lives in global.css — RN has no backdrop-filter, and
          this tags the node so the rule can find it. */}
      <View style={styles.nav} {...webDataAttr('nav-blur')}>
        <View style={styles.navInner}>
          {logo}
          {!compact && <SectionLinks />}
          <View style={styles.actions}>
            {!compact && <SignInButton />}
            {session ? <AccountButton /> : signUp}
            {compact && (
              <Pressable
                onPress={onToggleMenu}
                role="button"
                accessibilityLabel={t('nav.menu')}
                // aria-* explicitly: accessibilityState alone does not reach
                // the DOM through react-native-web here, same as the language
                // switch's checked state.
                aria-expanded={menuOpen}
                accessibilityState={{ expanded: menuOpen }}
                style={styles.burger}
              >
                <Text style={styles.burgerGlyph}>☰</Text>
              </Pressable>
            )}
          </View>
        </View>
      </View>

      {compact && menuOpen && <MobileMenu onNavigate={onCloseMenu} />}
    </View>
  );
}

function SectionLinks() {
  const { t } = useLocale();
  const { scrollToSection } = useSectionScroll();
  return (
    <View style={styles.links}>
      {SECTION_LINKS.map((link) => (
        <Pressable
          key={link.id}
          onPress={() => scrollToSection(link.id)}
          accessibilityRole="link"
          style={({ pressed }) => [pressed && styles.pressed]}
        >
          {({ hovered }) => (
            <Text style={[styles.linkText, hovered && styles.linkTextHovered]}>{t(link.key)}</Text>
          )}
        </Pressable>
      ))}
    </View>
  );
}

function MobileMenu({ onNavigate }: { onNavigate: () => void }) {
  const { t } = useLocale();
  const { scrollToSection } = useSectionScroll();
  return (
    <View style={styles.menu}>
      {SECTION_LINKS.map((link) => (
        <Pressable
          key={link.id}
          accessibilityRole="link"
          onPress={() => {
            onNavigate();
            scrollToSection(link.id);
          }}
          style={styles.menuRow}
        >
          <Text style={styles.menuText}>{t(link.key)}</Text>
        </Pressable>
      ))}
      <View style={styles.menuSignIn}>
        <SignInButton full />
      </View>
    </View>
  );
}

// Not a TabTrigger: /login is a sibling Stack screen in (public)/_layout.web.tsx,
// not one of this group's routes.
function SignInButton({ full }: { full?: boolean }) {
  const router = useRouter();
  const { t } = useLocale();
  return (
    <Pressable
      onPress={() => router.push('/login')}
      accessibilityRole="link"
      style={({ pressed, hovered }) => [
        styles.ghostButton,
        full && styles.buttonFull,
        hovered && styles.ghostButtonHovered,
        pressed && styles.pressed,
      ]}
    >
      <Text style={styles.ghostButtonText}>{t('nav.signIn')}</Text>
    </Pressable>
  );
}

function LogoLink(props: TabTriggerSlotProps) {
  return (
    <Pressable {...props} accessibilityRole="link" style={({ pressed }) => [pressed && styles.pressed]}>
      <KaiibiLockup tone="dark" />
    </Pressable>
  );
}

function SignUpButton({ isFocused, style: _style, ...props }: TabTriggerSlotProps) {
  const { t } = useLocale();
  const { width } = useWindowDimensions();
  return (
    <Pressable
      {...props}
      accessibilityRole="link"
      style={({ pressed, hovered }) => [
        styles.primaryButton,
        hovered && styles.primaryButtonHovered,
        pressed && styles.pressed,
      ]}
    >
      <Text style={styles.primaryButtonText} numberOfLines={1}>
        {t(width < 420 ? 'nav.getStartedShort' : 'nav.getStarted')}
      </Text>
    </Pressable>
  );
}

// `about` has to be declared as a TabTrigger for expo-router/ui to treat it as
// one of this group's routes, but the design gives it no header slot — the
// footer's "About" link is its entry point. Rendered zero-size rather than
// omitted, because dropping the trigger changes what the Tabs group knows
// about.
function HiddenTrigger(props: TabTriggerSlotProps) {
  return <Pressable {...props} style={styles.hidden} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" />;
}

// Reuses the sign-up slot's position and styling so swapping between the
// signed-out and signed-in states doesn't shift the layout. Not a TabTrigger:
// it targets /dashboard, which lives outside this Tabs group's own routes.
function AccountButton() {
  const router = useRouter();
  const { t } = useLocale();
  const { shop } = useAuth();
  return (
    <Pressable
      onPress={() => router.push('/dashboard')}
      accessibilityRole="link"
      style={({ pressed, hovered }) => [
        styles.primaryButton,
        styles.accountButton,
        hovered && styles.primaryButtonHovered,
        pressed && styles.pressed,
      ]}
    >
      <Text style={styles.primaryButtonText} numberOfLines={1}>
        {shop?.name || t('nav.myShop')}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  slot: { height: '100%' },
  // flexDirection is explicit rather than relying on RN's column default:
  // TabList supplies its own row direction, and this View has to override it.
  header: { position: 'absolute', top: 0, width: '100%', zIndex: 20, flexDirection: 'column' },

  langBar: { backgroundColor: Marketing.ink },
  langBarInner: {
    width: '100%',
    maxWidth: MarketingLayout.maxWidth,
    alignSelf: 'center',
    paddingHorizontal: MarketingLayout.gutter,
    paddingVertical: 9,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
    gap: 12,
  },
  langBarText: { color: 'rgba(255,255,255,0.85)', fontSize: 13, flexShrink: 1 },

  nav: {
    backgroundColor: 'rgba(255,255,255,0.88)',
    borderBottomWidth: 1,
    borderBottomColor: Marketing.line,
  },
  // Real flex, replacing the absolute `right: 209 / 121 / 26` offsets this
  // file used to carry. Those broke the moment a label's length changed —
  // which is exactly what a second language does.
  navInner: {
    width: '100%',
    maxWidth: MarketingLayout.maxWidth,
    alignSelf: 'center',
    paddingHorizontal: MarketingLayout.gutter,
    height: 70,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 20,
  },
  links: { flexDirection: 'row', gap: 28, flexShrink: 1 },
  linkText: { fontSize: 14.5, fontWeight: '600', color: Marketing.gray700 },
  linkTextHovered: { color: Marketing.ink },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 12 },

  primaryButton: {
    backgroundColor: Marketing.ink,
    borderRadius: MarketingRadius.pill,
    paddingVertical: 13,
    paddingHorizontal: 26,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryButtonHovered: { backgroundColor: Marketing.ink2 },
  primaryButtonText: { color: Marketing.white, fontSize: 14.5, fontWeight: '700' },
  accountButton: { maxWidth: 170 },

  ghostButton: {
    borderWidth: 1,
    borderColor: Marketing.line,
    borderRadius: MarketingRadius.pill,
    paddingVertical: 13,
    paddingHorizontal: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ghostButtonHovered: { backgroundColor: Marketing.gray50 },
  ghostButtonText: { color: Marketing.ink, fontSize: 14.5, fontWeight: '700' },
  buttonFull: { alignSelf: 'stretch' },

  burger: { paddingHorizontal: 4, paddingVertical: 2 },
  burgerGlyph: { fontSize: 22, color: Marketing.ink, lineHeight: 26 },

  menu: {
    backgroundColor: Marketing.white,
    borderBottomWidth: 1,
    borderBottomColor: Marketing.line,
    paddingHorizontal: MarketingLayout.gutter,
    paddingTop: 12,
    paddingBottom: 20,
  },
  menuRow: { paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: Marketing.gray100 },
  menuText: { fontSize: 14.5, fontWeight: '600', color: Marketing.gray700 },
  menuSignIn: { marginTop: 12 },

  hidden: { width: 0, height: 0, opacity: 0, position: 'absolute' },
  pressed: { opacity: 0.75 },
});
