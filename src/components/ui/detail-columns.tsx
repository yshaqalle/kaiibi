import { type ReactNode } from 'react';
import { StyleSheet, useWindowDimensions, View } from 'react-native';

import { detailColumnsForWidth } from '@/constants/layout';

export function useDetailColumns(): 1 | 2 {
  const { width } = useWindowDimensions();
  return detailColumnsForWidth(width);
}

// The People detail pane's body.
//
// Left is who the person is and what you would change about them; right is
// what they have done. That split is not arbitrary -- it puts every editable
// control in one column, so the eye does not hunt between two for the next
// action.
//
// NOT BentoGrid/BentoCell: those size cells by percentage width and set
// alignItems 'flex-start', so a short column does not stretch to its
// neighbour's height. Here both columns must fill the pane, because the right
// one contains a card that bounds its own scrolling against that height.
export function DetailColumns({ left, right }: { left: ReactNode; right: ReactNode }) {
  const columns = useDetailColumns();

  if (columns === 1) {
    return <View style={styles.stack}>{left}{right}</View>;
  }

  return (
    <View style={styles.row}>
      <View style={styles.column}>{left}</View>
      <View style={styles.column}>{right}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  // One column: a plain stack. The caller is inside a ScrollView at this
  // width (TwoPaneListDetail's detailFills is false below the two-column
  // breakpoint), so nothing here may flex.
  stack: { gap: 14 },
  row: { flexDirection: 'row', gap: 14, flex: 1, minHeight: 0, alignItems: 'stretch' },
  // minWidth 0 lets a long product name shrink the column rather than
  // widening it past its half of the pane.
  column: { flex: 1, minWidth: 0, gap: 14 },
});

/**
 * For a card that should take the remaining height of its column and scroll
 * its own body -- a purchase ledger, a shift list. Spread onto a `BentoCard`
 * as `style={detailCardStyles.fill}` and `bodyStyle={detailCardStyles.fillBody}`,
 * ONLY when `useDetailColumns()` is 2. At one column the card is inside a
 * ScrollView and must size to its content instead.
 */
export const detailCardStyles = StyleSheet.create({
  fill: { flex: 1, minHeight: 0 },
  fillBody: { flex: 1, minHeight: 0 },
});
