import { Pressable, StyleSheet, Text, View } from 'react-native';

import { AppModal } from '@/components/ui/app-modal';
import { Colors } from '@/constants/theme';

// Pinned to the light palette, like the screen this sheet opens over.
const theme = Colors.light;

export type StockAction = 'restock' | 'move' | 'import';

export function StockActionsSheet({
  visible,
  onClose,
  onPick,
  showMove,
  onDismissed,
}: {
  visible: boolean;
  onClose: () => void;
  onPick: (action: StockAction) => void;
  showMove: boolean;
  // Fires once this sheet is actually off the screen (iOS only). Forwarded
  // straight to AppModal's `onDismiss`, exactly as CsvImportModal does -- this
  // is the hook the staged handover to the Restock modal hangs on, and without
  // it the phone path opens nothing.
  onDismissed?: () => void;
}) {
  if (!visible) return null;

  // Shared by the three live rows so hover, keyboard focus and press all read
  // as "this is a door", the same combination data-table.tsx and
  // attention-list.tsx already use for a selectable row. `hovered` and
  // `focused` are pointer/keyboard-only -- react-native-web sets them from
  // mouseenter/focus DOM events that a touch tap never fires -- so on a phone
  // `pressed` stays the only state that ever flips, exactly as it does today.
  const rowStyle = ({ pressed, ...state }: { pressed: boolean; hovered?: boolean; focused?: boolean }) => [
    styles.sheetRow,
    (state.hovered || state.focused) && styles.sheetRowHovered,
    pressed && styles.sheetRowPressed,
  ];

  return (
    <AppModal visible transparent animationType="slide" onRequestClose={onClose} onDismiss={onDismissed}>
      <Pressable style={styles.sheetOverlay} onPress={onClose} accessibilityLabel="Close">
        {/* Stops a tap inside the sheet from closing it. */}
        <Pressable style={styles.sheet} onPress={() => {}}>
          <View style={styles.sheetHead}>
            <Text style={styles.sheetTitle}>Stock</Text>
            <Pressable onPress={onClose} style={styles.pillButton}>
              <Text style={styles.pillButtonText}>Close</Text>
            </Pressable>
          </View>
          <Text style={styles.blurb}>
            Change the numbers. To add something you don&apos;t sell yet, use + Add product.
          </Text>

          {/* The hints are the feature, not decoration. Shops were reaching for
              product import to add stock to a store they already stocked, which
              re-counts the same units -- the reason stock-move-import.ts exists.
              Naming the arithmetic at the door is cheaper than a rejection read
              afterwards, and it is the one place all four jobs sit side by side
              where the difference between them is visible at all. */}
          <Pressable onPress={() => onPick('restock')} style={rowStyle}>
            <Text style={styles.sheetRowLabel}>Restock</Text>
            <Text style={styles.sheetRowHint}>
              A delivery arrived. Adds units to what a store already holds — 11 becomes 17.
            </Text>
          </Pressable>

          {/* Disabled rather than absent: the room behind this door is not built
              yet, but the distinction between adding and replacing is exactly
              what this sheet exists to teach, and it cannot teach it with the
              replacing half missing. Deliberately a View, never a Pressable --
              a plain opacity fade on a white card reads as a style choice, so
              the fade is paired with dropping the white card itself back to the
              sheet's own grey: it recedes into the background instead of
              sitting among the selectable ones. */}
          <View style={[styles.sheetRow, styles.sheetRowDisabled]} accessibilityState={{ disabled: true }}>
            <View style={styles.sheetRowHeading}>
              <Text style={[styles.sheetRowLabel, styles.sheetRowLabelDisabled]}>Count</Text>
              <View style={styles.badge}>
                <Text style={styles.badgeText}>Coming next</Text>
              </View>
            </View>
            <Text style={styles.sheetRowHint}>
              A stock-take. Replaces the count with what you actually found — 11 becomes 8, and the app records the −3.
            </Text>
          </View>

          {/* A one-store shop has nowhere to move stock TO, so the row would be
              a dead end -- the same reason the header's Move pill hid itself. */}
          {showMove && (
            <Pressable onPress={() => onPick('move')} style={rowStyle}>
              <Text style={styles.sheetRowLabel}>Move</Text>
              <Text style={styles.sheetRowHint}>
                Send units from one of your stores to another. Your total doesn&apos;t change.
              </Text>
            </Pressable>
          )}

          <Pressable onPress={() => onPick('import')} style={rowStyle}>
            <Text style={styles.sheetRowLabel}>Import products</Text>
            <Text style={styles.sheetRowHint}>
              Only for products you don&apos;t sell yet. Importing something you already carry would count the same units
              twice.
            </Text>
          </Pressable>
        </Pressable>
      </Pressable>
    </AppModal>
  );
}

// Copied from inventory.tsx's own More sheet, so a sheet opened from that sheet
// is the same object rather than a near-miss of it.
const styles = StyleSheet.create({
  sheetOverlay: { flex: 1, backgroundColor: 'rgba(11,11,13,0.45)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: theme.bentoPage, borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 16, paddingBottom: 28 },
  sheetHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 },
  sheetTitle: { fontSize: 17, fontWeight: '800', color: theme.bentoInk, letterSpacing: -0.3 },
  pillButton: {
    borderWidth: 1,
    borderColor: theme.bentoLine,
    backgroundColor: theme.bentoSurface,
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 7,
  },
  pillButtonText: { color: theme.bentoInk2, fontWeight: '700', fontSize: 12.5 },
  blurb: { fontSize: 12.5, color: theme.bentoMuted, lineHeight: 18, marginBottom: 12 },
  sheetRow: { backgroundColor: theme.bentoSurface, borderRadius: 16, paddingHorizontal: 15, paddingVertical: 13, marginBottom: 8 },
  // The wash `bentoSoft` already reads as "one step down from a white card"
  // elsewhere in this file (the badge sits on it) and in data-table.tsx's own
  // row-hover, so a pointer resting on a door tints it the same way rather
  // than inventing a new step. Press darkens further with the same opacity
  // dip landing-ui.tsx's buttons use, layered on top of whichever fill is
  // already showing.
  sheetRowHovered: { backgroundColor: theme.bentoSoft },
  sheetRowPressed: { opacity: 0.82 },
  // Count fades AND drops from the white `bentoSurface` card back to the
  // sheet's own `bentoPage` grey -- the fade alone read as a style choice on
  // a card that still looked selectable; losing the card too makes it recede
  // instead of merely dimming.
  sheetRowDisabled: { backgroundColor: theme.bentoPage, opacity: 0.65 },
  sheetRowHeading: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  sheetRowLabel: { fontSize: 14, fontWeight: '700', color: theme.bentoInk },
  // Same size, but the label itself stops reading as a bold black heading --
  // the cue that says "tap me" on the other three -- rather than relying on
  // the card-wide opacity to carry that alone.
  sheetRowLabelDisabled: { color: theme.bentoMuted },
  sheetRowHint: { fontSize: 11.5, color: theme.bentoMuted, marginTop: 2, lineHeight: 17 },
  badge: { backgroundColor: theme.bentoSoft, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2 },
  badgeText: { fontSize: 10, fontWeight: '800', color: theme.bentoMuted, letterSpacing: 0.3 },
});
