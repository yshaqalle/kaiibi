import { StyleSheet, Text, useWindowDimensions, View } from 'react-native';

import { LandingSection } from '@/components/landing/landing-section';
import { Card, SectionHead, gridCellStyle, gridRowStyle } from '@/components/landing/landing-ui';
import { Marketing, MarketingLayout } from '@/constants/marketing-theme';
import { useLocale } from '@/hooks/use-locale';

// ─────────────────────────────────────────────────────────────────────────────
// NOT RENDERED. This component is complete but deliberately unmounted, and it
// must stay that way until there are real quotes.
//
// The approved design shipped three five-star testimonials from named
// shopkeepers in Hargeisa, Bosaso and Borama. Those people are invented, and
// publishing invented customer reviews as genuine is not something to ship and
// fix later. The section exists here so that turning it on is one line in
// index.web.tsx plus a `reviews` entry in SectionId and the nav's SECTION_LINKS
// — not a rebuild.
//
// To enable: replace REVIEWS below with real, attributed quotes you have
// permission to publish, add the strings to both message tables, then mount it
// between LandingPlans and LandingFaq.
// ─────────────────────────────────────────────────────────────────────────────

type Review = { key: string; quote: string; name: string; detail: string; initials: string };

/** Intentionally empty — see the note above. */
const REVIEWS: Review[] = [];

const GUTTER = 22;

export function LandingReviews() {
  const { t } = useLocale();
  const { width } = useWindowDimensions();
  const columns = width >= MarketingLayout.compactBreakpoint ? 3 : 1;

  // Belt and braces: even if this is mounted by mistake, an empty list renders
  // nothing rather than an empty section with a heading over blank space.
  if (REVIEWS.length === 0) return null;

  return (
    <LandingSection narrow={width < MarketingLayout.narrowBreakpoint}>
      <SectionHead tag={t('reviews.tag')} title={t('reviews.title')} width={width} />
      <View style={gridRowStyle(GUTTER)}>
        {REVIEWS.map((review) => (
          <View key={review.key} style={gridCellStyle(columns, GUTTER)}>
            <Card style={styles.card}>
              <Text style={styles.stars}>★★★★★</Text>
              <Text style={styles.quote}>{review.quote}</Text>
              <View style={styles.who}>
                <View style={styles.avatar}>
                  <Text style={styles.avatarText}>{review.initials}</Text>
                </View>
                <View style={styles.whoText}>
                  <Text style={styles.name}>{review.name}</Text>
                  <Text style={styles.detail}>{review.detail}</Text>
                </View>
              </View>
            </Card>
          </View>
        ))}
      </View>
    </LandingSection>
  );
}

const styles = StyleSheet.create({
  card: { height: '100%' },
  stars: { color: Marketing.amber, fontSize: 14, letterSpacing: 2, marginBottom: 14 },
  quote: { fontSize: 15, lineHeight: 24, color: Marketing.gray700, marginBottom: 20 },
  who: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  avatar: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: Marketing.ink,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: { color: Marketing.white, fontWeight: '700', fontSize: 14 },
  whoText: { flexShrink: 1 },
  name: { fontSize: 14, fontWeight: '700', color: Marketing.ink },
  detail: { fontSize: 12.5, color: Marketing.gray400 },
});
