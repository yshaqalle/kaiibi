import { useState } from 'react';
import { Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';

import { LandingSection } from '@/components/landing/landing-section';
import { SectionHead } from '@/components/landing/landing-ui';
import { Marketing, MarketingLayout, MarketingRadius } from '@/constants/marketing-theme';
import { useLocale } from '@/hooks/use-locale';
import type { MessageKey } from '@/lib/i18n';

// One open at a time, the first open on load — matching the design's own
// accordion behaviour.
//
// Two answers differ from the supplied copy. Q3 used to ask "Does it work
// without internet?" and answered yes; it does not, so the question was
// replaced with multi-cashier, which is true. Q4's answer was narrowed: this
// change translates the public pages and sign-up, not the whole app, and
// promising otherwise on the FAQ page would be the first thing a Somali user
// discovered was false.

const ITEMS: { q: MessageKey; a: MessageKey }[] = [
  { q: 'faq.q1', a: 'faq.a1' },
  { q: 'faq.q2', a: 'faq.a2' },
  { q: 'faq.q3', a: 'faq.a3' },
  { q: 'faq.q4', a: 'faq.a4' },
  { q: 'faq.q5', a: 'faq.a5' },
  { q: 'faq.q6', a: 'faq.a6' },
];

export function LandingFaq() {
  const { t } = useLocale();
  const { width } = useWindowDimensions();
  const [openIndex, setOpenIndex] = useState<number | null>(0);

  return (
    <LandingSection id="faq" background="gray" narrow={width < MarketingLayout.narrowBreakpoint}>
      <SectionHead tag={t('faq.tag')} title={t('faq.title')} width={width} />
      <View style={styles.list}>
        {ITEMS.map((item, index) => {
          const open = openIndex === index;
          return (
            <View key={item.q} style={styles.item}>
              <Pressable
                onPress={() => setOpenIndex(open ? null : index)}
                accessibilityRole="button"
                accessibilityState={{ expanded: open }}
                style={({ hovered }) => [styles.question, hovered && styles.questionHovered]}
              >
                <Text style={styles.questionText}>{t(item.q)}</Text>
                {/* The design rotates a "+" 45° into a "×". A rotated glyph
                    reads as a cross to a sighted user and still announces as
                    "+" to a screen reader, so the expanded state above is what
                    actually carries the meaning. */}
                <Text style={[styles.chevron, open && styles.chevronOpen]}>+</Text>
              </Pressable>
              {open && (
                <View style={styles.answer}>
                  <Text style={styles.answerText}>{t(item.a)}</Text>
                </View>
              )}
            </View>
          );
        })}
      </View>
    </LandingSection>
  );
}

const styles = StyleSheet.create({
  list: { width: '100%', maxWidth: 780, alignSelf: 'center' },
  item: {
    borderWidth: 1,
    borderColor: Marketing.line,
    borderRadius: MarketingRadius.md,
    marginBottom: 12,
    backgroundColor: Marketing.white,
    overflow: 'hidden',
  },
  question: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 16,
    paddingVertical: 20,
    paddingHorizontal: 24,
  },
  questionHovered: { backgroundColor: Marketing.gray50 },
  questionText: { flex: 1, fontSize: 15.5, fontWeight: '700', color: Marketing.ink },
  chevron: { fontSize: 19, color: Marketing.gray400 },
  chevronOpen: { transform: [{ rotate: '45deg' }] },
  answer: { paddingHorizontal: 24, paddingBottom: 22 },
  answerText: { color: Marketing.gray500, fontSize: 14.5, lineHeight: 23 },
});
