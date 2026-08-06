import { type ReactNode } from 'react';
import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { Card } from '@/components/card';
import { Colors } from '@/constants/theme';

const theme = Colors.light;

// A bento card with a heading row: title on the left, and on the right either
// a scope pill or whatever the card needs there.
//
// The `scope` is the part worth explaining. Not every card obeys the date
// range: the revenue goal is a calendar-month commitment, cash balances and
// what you owe are facts about RIGHT NOW, and the rest follow the picker. The
// old screens said this once, in a footnote at the bottom, and left the reader
// to connect it back to the figure it applied to. Putting it in the heading
// means a card that ignores the range says so where the number is.
export function BentoCard({
  title,
  scope,
  actions,
  children,
  style,
  bodyStyle,
}: {
  title?: string;
  /** Short window label — "7 days", "This month", "As of today". */
  scope?: string;
  /** Replaces the scope pill when a card needs a real control there. */
  actions?: ReactNode;
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  /** For cards whose body manages its own padding, like a table. */
  bodyStyle?: StyleProp<ViewStyle>;
}) {
  const hasHead = Boolean(title || scope || actions);

  return (
    <Card variant="bento" style={[styles.card, style]}>
      {hasHead ? (
        <View style={styles.head}>
          {title ? (
            <Text style={styles.title} numberOfLines={2}>
              {title}
            </Text>
          ) : (
            <View style={styles.spacer} />
          )}
          {actions ?? (scope ? <Text style={styles.scope}>{scope}</Text> : null)}
        </View>
      ) : null}
      <View style={bodyStyle}>{children}</View>
    </Card>
  );
}

const styles = StyleSheet.create({
  card: { padding: 18 },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 12 },
  title: { fontSize: 15, fontWeight: '800', letterSpacing: -0.2, color: theme.bentoInk, flexShrink: 1 },
  // Keeps a lone action pinned right when there is no title beside it.
  spacer: { flex: 1 },
  scope: {
    fontSize: 12,
    fontWeight: '700',
    color: theme.bentoInk2,
    borderWidth: 1,
    borderColor: theme.bentoLine,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 5,
    // Without this the border is drawn outside the rounded corners on web.
    overflow: 'hidden',
  },
});
