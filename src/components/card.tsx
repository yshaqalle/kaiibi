import type { ReactNode } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { Colors } from '@/constants/theme';

// Pinned to the light palette for now — no dark-mode switching yet, so the
// dashboard's look stays exactly as it is today regardless of system theme.
const theme = Colors.light;

export function Card({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.card, { backgroundColor: theme.surface, borderColor: theme.border }, style]}>{children}</View>;
}

const styles = StyleSheet.create({
  card: { borderRadius: 12, borderWidth: 1 },
});
