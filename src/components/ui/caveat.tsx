import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Colors } from '@/constants/theme';

// Pinned to the light palette for now — no dark-mode switching yet.
const theme = Colors.light;

// The sentence that travels with a number.
//
// Accounting already writes genuinely good qualifications — that cost of goods
// is understated when items sold with no cost recorded, that stock purchases
// and owner draws sit outside operating expenses, that wages not yet posted
// move rather than change the total. They render today as small grey text
// under a card, which reads as boilerplate and gets skipped by exactly the
// person who needs them.
//
// A left rule, a tone and an action make them part of the figure instead.
//
// THE TONE IS THE MEANING, and picking the wrong one is worse than not using
// this at all:
//
//   'wrong'   this number is WRONG until you fix something. It has a cause the
//             reader can remove. Always give it an action.
//   'context' the number is RIGHT; here is why it looks surprising. No action
//             is required and none should be implied.
//   'partial' you are not permitted to see part of it, so the figure is
//             incomplete through no fault of the data.
//
// A 'wrong' caveat with no fix, or a 'context' one that actually needs action,
// trains people to ignore the whole family.

export type CaveatTone = 'wrong' | 'context' | 'partial';

const TONES: Record<CaveatTone, { rule: string; background: string; text: string; glyph: string }> = {
  wrong: { rule: theme.warning, background: '#FFFBEB', text: '#8A5A05', glyph: '⚠' },
  context: { rule: theme.chartAccent, background: '#EEF4FF', text: '#1E4BCC', glyph: 'ⓘ' },
  partial: { rule: theme.textSecondary, background: theme.backgroundElement, text: theme.textSecondary, glyph: '◔' },
};

export function Caveat({
  children,
  tone = 'context',
  action,
}: {
  children: string;
  tone?: CaveatTone;
  /** The thing that removes the caveat. Omit when there is nothing to do. */
  action?: { label: string; onPress: () => void };
}) {
  const colors = TONES[tone];

  return (
    <View style={[styles.caveat, { borderLeftColor: colors.rule, backgroundColor: colors.background }]}>
      <Text style={[styles.glyph, { color: colors.text }]}>{colors.glyph}</Text>
      <View style={styles.body}>
        <Text style={[styles.text, { color: colors.text }]}>{children}</Text>
        {action ? (
          <Pressable onPress={action.onPress} accessibilityRole="link" style={styles.actionRow}>
            <Text style={[styles.action, { color: colors.text }]}>{action.label} →</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  caveat: {
    flexDirection: 'row',
    gap: 11,
    borderLeftWidth: 3,
    borderTopRightRadius: 10,
    borderBottomRightRadius: 10,
    paddingVertical: 11,
    paddingHorizontal: 14,
    marginTop: 11,
  },
  glyph: { fontWeight: '800', fontSize: 13, lineHeight: 20 },
  body: { flex: 1, minWidth: 0 },
  text: { fontSize: 12.5, lineHeight: 20 },
  actionRow: { marginTop: 6, alignSelf: 'flex-start' },
  action: { fontSize: 12.5, fontWeight: '700', textDecorationLine: 'underline' },
});
