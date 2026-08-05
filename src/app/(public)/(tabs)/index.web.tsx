import { useEffect, useRef } from 'react';
import { Platform, SafeAreaView, ScrollView, StyleSheet } from 'react-native';

import { LandingCta } from '@/components/landing/landing-cta';
import { LandingDashboardPreview } from '@/components/landing/landing-dashboard-preview';
import { LandingFaq } from '@/components/landing/landing-faq';
import { LandingFeatures } from '@/components/landing/landing-features';
import { LandingFooter } from '@/components/landing/landing-footer';
import { LandingHero } from '@/components/landing/landing-hero';
import { LandingHow } from '@/components/landing/landing-how';
import { LandingPlans } from '@/components/landing/landing-plans';
import { LandingStats } from '@/components/landing/landing-stats';
import { LandingTrustStrip } from '@/components/landing/landing-trust-strip';
import { Marketing } from '@/constants/marketing-theme';
import { isSectionId, useSectionScroll } from '@/hooks/use-section-scroll';

// The marketing home page. Web only — on native `index.tsx` redirects to
// /login, whose hero carries the pitch instead.
//
// An assembler, not a page: each band owns its own copy and layout, and the
// nav/footer chrome comes from the (tabs) layout. The one thing that lives
// here is the ScrollView the sections measure themselves against.
//
// `LandingReviews` is deliberately absent — see the note at the top of that
// file before mounting it.
export default function LandingScreen() {
  const scrollRef = useRef<ScrollView>(null);
  const { attachScrollView, clearSections, scrollToSection } = useSectionScroll();

  useEffect(() => {
    attachScrollView(scrollRef.current);
    return () => clearSections();
  }, [attachScrollView, clearSections]);

  // An inbound `#plans` from an email or a WhatsApp message. Feeds the same
  // pending-section mechanism as a cross-page nav click, so it fires when the
  // section reports its offset rather than on a guess at a timeout.
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const hash = window.location.hash.replace('#', '');
    if (hash && isSectionId(hash)) scrollToSection(hash);
  }, [scrollToSection]);

  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView ref={scrollRef} showsVerticalScrollIndicator={false}>
        <LandingHero />
        <LandingTrustStrip />
        <LandingDashboardPreview />
        <LandingFeatures />
        <LandingHow />
        <LandingStats />
        <LandingPlans />
        <LandingFaq />
        <LandingCta />
        <LandingFooter />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: Marketing.white },
});
