import type { ReactNode } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Colors } from '@/constants/theme';

// Pinned to the light palette for now — no dark-mode switching yet. Only the
// People screen renders this, and People is a bento screen.
const theme = Colors.light;

// Shared list+detail shell for the People screen's two sub-tabs (Customers,
// Team). Wide: list and detail render side by side, both always visible.
// Compact: the list owns the screen and the detail opens in a bottom-sheet
// modal over it -- same overlay/sheet treatment as CheckoutPanel. Stacking
// the detail under the list (the earlier compact shape) meant every selection
// pushed the answer off-screen and had to be scrolled to.
//
// `compact` is computed by the caller and passed in rather than measured
// here, so this component owns no breakpoint logic of its own. `detailOpen`
// likewise: the caller knows whether anything is selected, and passes the
// placeholder `detail` for the wide pane when nothing is.
export function TwoPaneListDetail({
  compact,
  list,
  detail,
  detailOpen,
  onCloseDetail,
  detailTitle,
}: {
  compact: boolean;
  list: ReactNode;
  detail: ReactNode;
  detailOpen: boolean;
  onCloseDetail: () => void;
  detailTitle?: string;
}) {
  if (compact) {
    return (
      <View style={styles.compact}>
        <ScrollView contentContainerStyle={styles.compactContent}>{list}</ScrollView>
        <Modal visible={detailOpen} transparent animationType="slide" onRequestClose={onCloseDetail}>
          <View style={styles.overlay}>
            <View style={styles.sheet}>
              <View style={styles.sheetHeader}>
                <Text style={styles.sheetTitle}>{detailTitle ?? ''}</Text>
                <Pressable onPress={onCloseDetail} style={({ pressed }) => [styles.close, pressed && styles.closePressed]}>
                  <Text style={styles.closeText}>Close</Text>
                </Pressable>
              </View>
              <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.sheetContent}>
                {detail}
              </ScrollView>
            </View>
          </View>
        </Modal>
      </View>
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
  listPane: { width: '34%', minWidth: 280, maxWidth: 520, flexShrink: 0 },
  detailPane: { flex: 1, minWidth: 0 },
  paneScroll: { flex: 1 },
  paneContent: { flexGrow: 1 },
  compact: { flex: 1, minHeight: 0 },
  compactContent: { paddingBottom: 24 },
  overlay: { flex: 1, backgroundColor: 'rgba(11,11,13,0.45)', justifyContent: 'flex-end' },
  // The sheet is the PAGE, not a card: the detail arrives as a stack of bento
  // cards, and giving the sheet a white ground too would flatten them into it.
  sheet: {
    backgroundColor: theme.bentoPage,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    padding: 16,
    maxHeight: '85%',
  },
  sheetHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 },
  sheetTitle: { fontSize: 17, fontWeight: '800', color: theme.bentoInk, letterSpacing: -0.3 },
  sheetContent: { paddingBottom: 8 },
  close: { backgroundColor: theme.bentoSurface, paddingVertical: 7, paddingHorizontal: 14, borderRadius: 999 },
  closePressed: { opacity: 0.6 },
  closeText: { fontSize: 12.5, fontWeight: '700', color: theme.bentoInk2 },
});
