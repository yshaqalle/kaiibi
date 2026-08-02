import type { ReactNode } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

// Shared list+detail shell for the People screen's two sub-tabs (Task 11
// Customers, Task 12 Team). Wide: list and detail render side by side, both
// always visible. Compact: stacked in a single scroll, detail below the
// list once something is selected -- the same responsive shape pos.tsx
// already uses (useWindowDimensions() + TABLET_BREAKPOINT). `compact` is
// computed by the caller and passed in rather than measured here, so this
// component owns no breakpoint logic of its own.
export function TwoPaneListDetail({ compact, list, detail }: { compact: boolean; list: ReactNode; detail: ReactNode }) {
  if (compact) {
    return (
      <ScrollView contentContainerStyle={styles.compactContent}>
        <View>{list}</View>
        <View style={styles.compactDetail}>{detail}</View>
      </ScrollView>
    );
  }
  return (
    <View style={styles.split}>
      <View style={styles.listPane}>
        <ScrollView style={styles.paneScroll} contentContainerStyle={styles.paneContent} showsVerticalScrollIndicator={false}>
          {list}
        </ScrollView>
      </View>
      <View style={styles.detailPane}>
        <ScrollView style={styles.paneScroll} contentContainerStyle={styles.paneContent} showsVerticalScrollIndicator={false}>
          {detail}
        </ScrollView>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  split: { flexDirection: 'row', gap: 18, flex: 1, minHeight: 0 },
  listPane: { width: 300, flexShrink: 0 },
  detailPane: { flex: 1, minWidth: 0 },
  paneScroll: { flex: 1 },
  paneContent: { flexGrow: 1 },
  compactContent: { paddingBottom: 24 },
  compactDetail: { marginTop: 14 },
});
