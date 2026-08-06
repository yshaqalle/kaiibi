import { type ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View, type KeyboardTypeOptions, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';

import { BENTO_RADIUS, BENTO_RADIUS_TILE, Colors } from '@/constants/theme';
import { AppModal } from '@/components/ui/app-modal';

// Pinned to the light palette for now — no dark-mode switching yet.
const theme = Colors.light;

// The console's control vocabulary, in one place.
//
// Six tabs and two modals were each declaring their own button, chip and input
// styles off the same handful of hardcoded hexes, which is how they drifted:
// three different disabled greys, two different chip radii. These are the bento
// shapes, defined once.

/** A small uppercase label above a group. Not a heading — cards own those. */
export function SectionLabel({ children, tone = 'default' }: { children: string; tone?: 'default' | 'danger' }) {
  return <Text style={[styles.sectionLabel, tone === 'danger' && styles.sectionLabelDanger]}>{children.toUpperCase()}</Text>;
}

export function PlatformButton({
  label,
  onPress,
  disabled,
  danger,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ hovered, pressed }) => [
        styles.button,
        danger && styles.buttonDanger,
        disabled && styles.buttonDisabled,
        !disabled && (hovered || pressed) && styles.buttonActive,
      ]}
    >
      <Text style={[styles.buttonText, danger && styles.buttonTextDanger, disabled && styles.buttonTextDisabled]}>
        {label}
      </Text>
    </Pressable>
  );
}

export function Chip({ label, active, onPress }: { label: string; active?: boolean; onPress?: () => void }) {
  return (
    <Pressable onPress={onPress} disabled={!onPress} style={[styles.chip, active && styles.chipActive]}>
      <Text style={[styles.chipText, active && styles.chipTextActive]}>{label}</Text>
    </Pressable>
  );
}

/**
 * A text input on the bento soft fill, no border.
 *
 * `needed` is the amber state, and it means one thing only: this field is a
 * precondition for the buttons below it, and they are disabled until it is
 * filled. It is not styling for "important" — a field that is merely important
 * looks like every other field.
 */
export function Field({
  value,
  onChangeText,
  placeholder,
  needed,
  keyboardType,
  width,
  style,
}: {
  value: string;
  onChangeText: (next: string) => void;
  placeholder?: string;
  needed?: boolean;
  keyboardType?: KeyboardTypeOptions;
  width?: number;
  style?: StyleProp<TextStyle>;
}) {
  return (
    <TextInput
      value={value}
      onChangeText={onChangeText}
      placeholder={placeholder}
      placeholderTextColor={needed ? theme.bentoWarn : theme.bentoMuted2}
      keyboardType={keyboardType}
      style={[styles.field, needed && styles.fieldNeeded, width != null && { width }, style]}
    />
  );
}

/** A labelled field, for the payment and limit forms. */
export function LabelledField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <View style={styles.labelledField}>
      <Text style={styles.fieldLabel}>{label.toUpperCase()}</Text>
      {children}
    </View>
  );
}

/**
 * One modal, two presentations: a sheet rising from the bottom where the screen
 * is narrow, a centred dialog where there is room for one. Same content either
 * way.
 *
 * Tapping the dimmed area closes — the expected way out when the button is
 * below the fold.
 */
export function PlatformModal({
  title,
  compact,
  onClose,
  children,
}: {
  title: string;
  compact: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <AppModal visible transparent animationType={compact ? 'slide' : 'fade'} onRequestClose={onClose}>
      <View style={[styles.backdrop, !compact && styles.backdropCentred]}>
        <Pressable style={compact ? styles.dismiss : StyleSheet.absoluteFill} onPress={onClose} />
        <View style={compact ? styles.sheet : styles.dialog}>
          {compact ? <View style={styles.grabber} /> : null}
          <View style={styles.modalHead}>
            <Text style={styles.modalTitle} numberOfLines={1}>
              {title}
            </Text>
            <Pressable onPress={onClose} hitSlop={10}>
              <Text style={styles.modalClose}>✕</Text>
            </Pressable>
          </View>
          <ScrollView contentContainerStyle={styles.modalBody}>{children}</ScrollView>
        </View>
      </View>
    </AppModal>
  );
}

/** A row of controls that wraps. */
export function ActionRow({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.actionRow, style]}>{children}</View>;
}

const styles = StyleSheet.create({
  sectionLabel: {
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 0.9,
    color: theme.bentoMuted,
    marginTop: 18,
    marginBottom: 8,
  },
  sectionLabelDanger: { color: theme.bentoLoss },

  button: {
    backgroundColor: theme.bentoInk,
    borderRadius: 999,
    paddingHorizontal: 15,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: theme.bentoInk,
  },
  buttonActive: { opacity: 0.85 },
  buttonDanger: { backgroundColor: 'transparent', borderColor: `${theme.bentoLoss}44` },
  buttonDisabled: { backgroundColor: theme.bentoSoft, borderColor: theme.bentoLine },
  buttonText: { color: theme.bentoSurface, fontSize: 12, fontWeight: '800' },
  buttonTextDanger: { color: theme.bentoLoss },
  buttonTextDisabled: { color: theme.bentoMuted2 },

  chip: {
    borderWidth: 1,
    borderColor: theme.bentoLine,
    backgroundColor: theme.bentoSurface,
    borderRadius: 999,
    paddingHorizontal: 13,
    paddingVertical: 6,
  },
  chipActive: { backgroundColor: theme.bentoInk, borderColor: theme.bentoInk },
  chipText: { fontSize: 12, fontWeight: '700', color: theme.bentoInk2 },
  chipTextActive: { color: theme.bentoSurface },

  field: {
    backgroundColor: theme.bentoSoft,
    borderRadius: BENTO_RADIUS_TILE,
    paddingHorizontal: 14,
    paddingVertical: 11,
    fontSize: 12.5,
    color: theme.bentoInk,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  fieldNeeded: { backgroundColor: `${theme.bentoWarn}12`, borderColor: `${theme.bentoWarn}40` },
  labelledField: { gap: 5 },
  fieldLabel: { fontSize: 10, fontWeight: '800', letterSpacing: 0.9, color: theme.bentoMuted },

  actionRow: { flexDirection: 'row', gap: 8, flexWrap: 'wrap', alignItems: 'center' },

  backdrop: { flex: 1, backgroundColor: 'rgba(11,11,13,0.4)', justifyContent: 'flex-end' },
  backdropCentred: { justifyContent: 'center', alignItems: 'center', padding: 24 },
  dismiss: { flex: 1 },
  dialog: {
    backgroundColor: theme.bentoSurface,
    borderRadius: BENTO_RADIUS,
    width: '100%',
    maxWidth: 760,
    maxHeight: '88%',
    overflow: 'hidden',
  },
  sheet: {
    backgroundColor: theme.bentoSurface,
    borderTopLeftRadius: BENTO_RADIUS,
    borderTopRightRadius: BENTO_RADIUS,
    maxHeight: '88%',
    paddingTop: 8,
  },
  grabber: { alignSelf: 'center', width: 38, height: 4, borderRadius: 2, backgroundColor: theme.bentoLine, marginBottom: 4 },
  modalHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 22,
    paddingTop: 18,
    paddingBottom: 4,
    gap: 12,
  },
  modalTitle: { fontSize: 20, fontWeight: '800', letterSpacing: -0.6, color: theme.bentoInk, flex: 1 },
  modalClose: { fontSize: 15, color: theme.bentoMuted, fontWeight: '700' },
  modalBody: { padding: 22, paddingTop: 12, paddingBottom: 30 },
});
