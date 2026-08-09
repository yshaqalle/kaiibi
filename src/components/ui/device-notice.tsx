import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Colors } from '@/constants/theme';

// Pinned to the light palette for now — no dark-mode switching yet.
const theme = Colors.light;

// The device is telling you something.
//
// A cousin of `Caveat`, deliberately not a sibling: a caveat is the sentence
// that travels with a NUMBER, its tone is the meaning, and `context` must
// never carry an action. This is for hardware and setup facts — a cable, a
// keyboard, a printer — where the action IS the point. No 4px tone rule and
// no tint: that pair is the caveat family's uniform and it stays theirs. A
// plain white card with a soft glyph well reads one step quieter than a data
// warning.
export function DeviceNotice({
  glyph,
  children,
  action,
  onDismiss,
}: {
  /** One character, e.g. "⌨". Drawn in a soft square well, never colour-coded. */
  glyph: string;
  children: string;
  /** The thing that resolves the notice. Omit when there is nothing to do. */
  action?: { label: string; onPress: () => void };
  /** Lets the reader close it. The CALLER owns what dismissal means. */
  onDismiss?: () => void;
}) {
  return (
    <View style={styles.card}>
      <View style={styles.glyphWell}>
        <Text style={styles.glyph}>{glyph}</Text>
      </View>
      <View style={styles.body}>
        <Text style={styles.text}>{children}</Text>
        {action ? (
          <Pressable onPress={action.onPress} style={styles.action} accessibilityRole="button">
            <Text style={styles.actionLabel}>{action.label}</Text>
          </Pressable>
        ) : null}
      </View>
      {onDismiss ? (
        <Pressable onPress={onDismiss} style={styles.dismiss} accessibilityLabel="Dismiss" accessibilityRole="button">
          <Text style={styles.dismissGlyph}>✕</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: theme.bentoSurface,
    borderRadius: 16,
    padding: 13,
    flexDirection: 'row',
    gap: 10,
    alignItems: 'flex-start',
    marginBottom: 12,
  },
  glyphWell: {
    width: 26,
    height: 26,
    borderRadius: 8,
    backgroundColor: theme.bentoSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  glyph: { fontSize: 13, color: theme.bentoInk2 },
  body: { flex: 1 },
  text: { fontSize: 12, lineHeight: 18, color: theme.bentoInk2 },
  action: {
    alignSelf: 'flex-start',
    marginTop: 7,
    backgroundColor: theme.bentoInk,
    borderRadius: 999,
    paddingHorizontal: 11,
    paddingVertical: 5,
  },
  actionLabel: { fontSize: 11, fontWeight: '800', color: theme.bentoSurface },
  dismiss: { padding: 2 },
  dismissGlyph: { fontSize: 13, color: theme.bentoMuted2 },
});
