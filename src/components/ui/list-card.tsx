import { useState, type ReactNode } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { BentoCard } from '@/components/ui/bento-card';
import { Colors } from '@/constants/theme';

const theme = Colors.light;

// A list that is usually short and occasionally very long.
//
// Four cards on the People screen are like this -- purchase history, points
// history, recent shifts, time off requests -- and they share a problem: the
// fields around them are a fixed size while they are not, so one customer with
// forty orders decides the height of a pane that everyone else reads.
//
// The card shows the first `previewCount` rows and opens the rest in a modal.
// A preview rather than a bare count because the common case IS the preview: a
// customer with one order has their whole history on the card and never sees a
// "View all" at all. Only the long tail costs a tap.
export function ListCard<T>({
  title,
  scope,
  subtitle,
  rows,
  keyExtractor,
  renderRow,
  emptyLabel,
  previewCount = 2,
  actions,
  footer,
}: {
  title: string;
  /** The pill in the card head -- "4 orders", "148 balance". */
  scope?: string;
  /** Shown under the title in the MODAL only. Whose list this is. */
  subtitle?: string;
  rows: T[];
  keyExtractor: (row: T) => string;
  renderRow: (row: T) => ReactNode;
  emptyLabel: string;
  previewCount?: number;
  /** Replaces the scope pill in the card head when the card needs a control. */
  actions?: ReactNode;
  /** Rendered inside the modal, below the list. For a caveat about the list. */
  footer?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const preview = rows.slice(0, previewCount);
  const hidden = rows.length - preview.length;

  return (
    <BentoCard title={title} scope={actions ? undefined : scope} actions={actions}>
      {rows.length === 0 ? (
        <Text style={styles.empty}>{emptyLabel}</Text>
      ) : (
        <>
          {preview.map((row) => (
            <View key={keyExtractor(row)}>{renderRow(row)}</View>
          ))}
          {/* Only when there IS more. A card showing everything it has should
              not invite a tap that reveals the same thing again. */}
          {hidden > 0 && (
            <Pressable
              onPress={() => setOpen(true)}
              accessibilityRole="button"
              accessibilityLabel={`View all ${rows.length} in ${title}`}
              testID="list-card-view-all"
              style={({ pressed }) => [styles.viewAll, pressed && styles.pressed]}
            >
              <Text style={styles.viewAllText}>{`View all ${rows.length} →`}</Text>
            </Pressable>
          )}
        </>
      )}

      <Modal visible={open} transparent animationType="slide" onRequestClose={() => setOpen(false)}>
        <View style={styles.overlay}>
          <View style={styles.sheet}>
            <View style={styles.head}>
              <View style={styles.headTitles}>
                <Text style={styles.modalTitle}>{title}</Text>
                {/* Whose list this is. "Purchase history" alone is ambiguous
                    the moment two people have been open in one session. */}
                {subtitle ? <Text style={styles.modalSub}>{subtitle}</Text> : null}
              </View>
              <Pressable
                onPress={() => setOpen(false)}
                accessibilityRole="button"
                accessibilityLabel={`Close ${title} list`}
                style={({ pressed }) => [styles.close, pressed && styles.pressed]}
              >
                <Text style={styles.closeText}>Close</Text>
              </Pressable>
            </View>
            <ScrollView style={styles.body} showsVerticalScrollIndicator={false}>
              {rows.map((row) => (
                <View key={keyExtractor(row)}>{renderRow(row)}</View>
              ))}
              {footer}
            </ScrollView>
          </View>
        </View>
      </Modal>
    </BentoCard>
  );
}

const styles = StyleSheet.create({
  empty: { fontSize: 13, color: theme.bentoMuted },
  viewAll: { paddingTop: 10 },
  viewAllText: { fontSize: 12.5, fontWeight: '800', color: theme.bentoInk },
  pressed: { opacity: 0.6 },
  overlay: { flex: 1, backgroundColor: 'rgba(11,11,13,0.45)', justifyContent: 'flex-end' },
  // The page grey, not white: the sheet is a ground, and giving it the card's
  // own fill would flatten the two into one surface.
  sheet: { backgroundColor: theme.bentoSurface, borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 18, maxHeight: '85%' },
  head: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, marginBottom: 14 },
  headTitles: { flexShrink: 1 },
  modalTitle: { fontSize: 19, fontWeight: '800', letterSpacing: -0.4, color: theme.bentoInk },
  modalSub: { fontSize: 12.5, color: theme.bentoMuted, marginTop: 2 },
  close: { backgroundColor: theme.bentoSoft, paddingVertical: 7, paddingHorizontal: 14, borderRadius: 999 },
  closeText: { fontSize: 12.5, fontWeight: '700', color: theme.bentoInk2 },
  body: { flexGrow: 0 },
});
