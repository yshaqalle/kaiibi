import { type ReactNode } from 'react';
import { StyleSheet, useWindowDimensions, View } from 'react-native';

import { detailColumnsForWidth } from '@/constants/layout';

function useDetailColumns(): 1 | 2 {
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
  // width, so nothing here may flex.
  stack: { gap: 14 },
  // The row itself doesn't flex -- it always sits inside a ScrollView here,
  // where `flex: 1` has nothing to flex against. `alignItems: 'stretch'`
  // (the flexbox default, kept explicit) is what actually equalises the two
  // columns' height, by stretching each `column` View to the row's own
  // cross-axis size.
  row: { flexDirection: 'row', gap: 14, alignItems: 'stretch' },
  // minWidth 0 lets a long product name shrink the column rather than
  // widening it past its half of the pane.
  column: { flex: 1, minWidth: 0, gap: 14 },
});
