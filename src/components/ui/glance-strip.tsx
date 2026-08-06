import { type ReactNode } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { Card } from '@/components/card';

// The headline figures at the top of a People tab.
//
// Deliberately NOT a `BentoCard`: this card has no title. "Customers at a
// glance" / "The team at a glance" says nothing the tile labels underneath it
// don't already say, and on a screen where the chrome was eating 40% of the
// window before the panes got a say, a redundant heading is 27px that buys
// nothing.
//
// What it does NOT drop is the per-tile hint. That was the other candidate --
// collapse the four tiles to one inline row of figures -- and it wins more
// height by deleting three of the four qualifications. "In today: 3" without
// "clocked in at some point" reads as a count of who is on the floor now,
// which it is not. The height comes out of the detail pane's layout instead
// (see DetailColumns).
export function GlanceStrip({
  children,
  caveat,
  style,
}: {
  children: ReactNode;
  /** Rendered below the tiles, inside the card -- it explains them. */
  caveat?: ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <Card variant="bento" style={[styles.card, style]}>
      <View style={styles.row}>{children}</View>
      {caveat}
    </Card>
  );
}

const styles = StyleSheet.create({
  // 12, not BentoCard's 18: the tiles carry their own padding and the card is
  // only a ground for them.
  card: { padding: 12 },
  // flexWrap + the tiles' own minWidth is what drops them to a second line on
  // a phone rather than crushing four onto one.
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
});
