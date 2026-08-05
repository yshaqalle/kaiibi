import type { ReactNode } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { BENTO_RADIUS, Colors } from '@/constants/theme';

// Pinned to the light palette for now — no dark-mode switching yet, so the
// dashboard's look stays exactly as it is today regardless of system theme.
const theme = Colors.light;

export function Card({
  children,
  style,
  variant = 'default',
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  /**
   * `bento` is the borderless 26px-radius white card the Dashboard and
   * Accounting use. The default is unchanged and stays on 12px with a
   * hairline, because POS, Inventory, People and Settings all render it.
   */
  variant?: 'default' | 'bento';
}) {
  if (variant === 'bento') {
    return <View style={[styles.card, styles.bento, style]}>{children}</View>;
  }
  return <View style={[styles.card, { backgroundColor: theme.surface, borderColor: theme.border }, style]}>{children}</View>;
}

const styles = StyleSheet.create({
  card: { borderRadius: 12, borderWidth: 1 },
  // No border: the bento reads as cards floating on a grey page, and a
  // hairline on white-over-#f4f4f5 muddies that separation rather than
  // sharpening it.
  bento: { borderRadius: BENTO_RADIUS, borderWidth: 0, backgroundColor: theme.bentoSurface },
});
