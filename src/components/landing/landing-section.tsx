import { type ReactNode } from 'react';
import { StyleSheet, View, type LayoutChangeEvent, type StyleProp, type ViewStyle } from 'react-native';

import { Marketing, MarketingLayout } from '@/constants/marketing-theme';
import { useSectionScroll, type SectionId } from '@/hooks/use-section-scroll';

// One band of the landing page: full-bleed background, content centred inside
// `maxWidth`, and — when it carries an `id` — the thing that reports its own
// position so the nav can scroll to it.
//
// The offset needs no `measureLayout`: every section is a DIRECT child of the
// landing ScrollView's content container, so `onLayout`'s `layout.y` is already
// relative to that container, which is exactly what `scrollTo` wants.
//
// Note this re-fires on resize, so offsets self-heal when a breakpoint changes
// a section's height. The gap is one layout pass wide: a click landing in that
// same frame scrolls slightly short.

export function LandingSection({
  id,
  children,
  background = 'white',
  padded = true,
  narrow,
  style,
}: {
  id?: SectionId;
  children: ReactNode;
  background?: 'white' | 'gray' | 'ink';
  /** Vertical section padding. Off for full-bleed bands like the trust strip. */
  padded?: boolean;
  /** True below `narrowBreakpoint` — tightens the vertical rhythm. */
  narrow?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const { registerSection } = useSectionScroll();

  const onLayout = id
    ? (event: LayoutChangeEvent) => registerSection(id, event.nativeEvent.layout.y)
    : undefined;

  return (
    <View
      onLayout={onLayout}
      style={[
        BACKGROUNDS[background],
        padded && (narrow ? styles.padNarrow : styles.pad),
        style,
      ]}
    >
      <View style={styles.wrap}>{children}</View>
    </View>
  );
}

const BACKGROUNDS = StyleSheet.create({
  white: { backgroundColor: Marketing.white },
  gray: { backgroundColor: Marketing.gray50 },
  ink: { backgroundColor: Marketing.ink },
});

const styles = StyleSheet.create({
  pad: { paddingVertical: 86 },
  padNarrow: { paddingVertical: 60 },
  wrap: {
    width: '100%',
    maxWidth: MarketingLayout.maxWidth,
    alignSelf: 'center',
    paddingHorizontal: MarketingLayout.gutter,
  },
});
