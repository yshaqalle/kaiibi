import { Fragment } from 'react';
import { Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';

import { TABLET_BREAKPOINT } from '@/constants/layout';
import { Colors } from '@/constants/theme';

const theme = Colors.light;

/**
 * One level of the path. The LAST step is where you are, and it carries no
 * `onPress` -- a link to the screen you are already on is a link that does
 * nothing, and offering it teaches people the crumb is decorative.
 */
export type CrumbStep = { label: string; onPress?: () => void };

/**
 * The one row above the title on every Accounting screen, replacing two things
 * that were there before.
 *
 * It replaces a HARDCODED eyebrow. The shell rendered the literal string
 * "ACCOUNTING" above the title on all nine tabs and all eighteen views, so the
 * line occupying the most prominent "where am I" slot was the one line
 * guaranteed never to answer it.
 *
 * And it replaces `LedgerCrumb`, the separate "← Accounting" back row beneath
 * that eyebrow. Two rows saying overlapping things become one row saying the
 * whole path, and the back affordance falls out of it: every ancestor is
 * pressable, so the crumb IS the way back rather than sitting next to it.
 *
 * Together those two removals are why the word "Accounting" appeared four
 * times on a drilled-in screen -- sidebar, eyebrow, back link, tab pill -- in
 * four different meanings. It now appears twice, and the two are the module in
 * the sidebar and the module in the crumb, which are the same thing.
 */
export function AccountingCrumb({ trail }: { trail: CrumbStep[] }) {
  const { width } = useWindowDimensions();

  // Three levels do not fit on a phone, so the MODULE goes first -- it is the
  // level you are least likely to have lost track of, because you tapped
  // Accounting in the nav to get here. It becomes a bare arrow rather than
  // disappearing: dropping it would take the tap target with it, and going up
  // a level is exactly what someone reading a crumb on a small screen wants.
  //
  // Only when there is something to save room FOR. A two-step trail fits, so
  // abbreviating it would cost a word and buy nothing.
  const collapseModule = width < TABLET_BREAKPOINT && trail.length > 2;

  return (
    <View style={styles.row}>
      {trail.map((step, index) => {
        const last = index === trail.length - 1;
        const abbreviated = collapseModule && index === 0;
        const label = abbreviated ? '←' : step.label;
        return (
          <Fragment key={`${step.label}-${index}`}>
            {index > 0 && (
              <Text style={styles.sep} accessible={false}>
                ›
              </Text>
            )}
            {step.onPress && !last ? (
              <Pressable
                onPress={step.onPress}
                role="link"
                // The word is gone on a phone but the destination is not, so
                // the accessible name still says where this goes.
                accessibilityLabel={`Go to ${step.label}`}
                style={styles.step}
              >
                <Text style={[styles.link, abbreviated && styles.arrow]}>{label}</Text>
              </Pressable>
            ) : (
              <View style={styles.step}>
                <Text style={[styles.link, last && styles.here]} accessibilityRole={last ? 'header' : undefined}>
                  {label}
                </Text>
              </View>
            )}
          </Fragment>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  // Wraps rather than truncating: on a narrow screen a second line of crumb is
  // readable where "General Journal E..." is not, and the leaf is the step that
  // would be cut.
  row: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 7, marginBottom: 6 },
  step: { paddingVertical: 2 },
  link: { fontSize: 12.5, fontWeight: '700', color: theme.bentoMuted },
  // Bigger than the label it replaces, because a lone arrow at 12.5px is a
  // hard target on a phone and it is now carrying a whole level.
  arrow: { fontSize: 15, lineHeight: 17 },
  // The leaf is the darkest thing in the row -- it is where you are, and the
  // ancestors are context for it.
  here: { color: theme.bentoInk2, fontWeight: '800' },
  // Lighter than either, so the path reads as steps rather than as a sentence
  // with punctuation in it. `bentoMuted3` is the de-emphasised step of the
  // same ramp, which is exactly this job.
  sep: { fontSize: 12.5, color: theme.bentoMuted3 },
});
