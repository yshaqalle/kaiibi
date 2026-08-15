import { StyleSheet, Text, View } from 'react-native';

import { Colors } from '@/constants/theme';
import { formatCents } from '@/lib/currency';
import { secondaryAmount } from '@/lib/display-currency';
import type { Currency } from '@/types/models';

// Pinned to the light palette for now -- no dark-mode switching yet.
const theme = Colors.light;

// One money figure and its echo in the shop's own currency. A single component
// so a tile, a cart line and the total can never space the pair differently or
// convert it at two different rates.
export function DualAmount({
  cents,
  currency,
  size = 'line',
  align = 'right',
}: {
  cents: number;
  currency: Currency | null;
  size?: 'tile' | 'line' | 'total';
  align?: 'left' | 'right';
}) {
  const secondary = secondaryAmount(cents, currency);
  return (
    <View style={align === 'right' ? styles.right : styles.left}>
      <Text style={[styles.primary, size === 'tile' && styles.primaryTile, size === 'total' && styles.primaryTotal]}>
        {formatCents(cents)}
      </Text>
      {secondary !== null && (
        <Text style={[styles.secondary, size === 'total' && styles.secondaryTotal]}>{secondary}</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  right: { alignItems: 'flex-end' },
  left: { alignItems: 'flex-start' },
  primary: { color: theme.bentoInk, fontSize: 13, fontWeight: '800', fontVariant: ['tabular-nums'] },
  primaryTile: { fontSize: 13.5 },
  primaryTotal: { fontSize: 30, letterSpacing: -1 },
  // Deliberately quiet: it is the same money said again for the customer's ear,
  // not a second figure anyone reconciles.
  secondary: { color: theme.bentoMuted2, fontSize: 10, fontWeight: '600', fontVariant: ['tabular-nums'] },
  secondaryTotal: { fontSize: 11 },
});
