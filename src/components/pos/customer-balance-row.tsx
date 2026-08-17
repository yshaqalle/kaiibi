import { Pressable, StyleSheet, Text, View } from 'react-native';

import { BENTO_RADIUS_TILE, Colors } from '@/constants/theme';
import { formatCents } from '@/lib/currency';
import { secondaryAmount } from '@/lib/display-currency';
import type { Currency } from '@/types/models';

// Pinned to the light palette for now -- no dark-mode switching yet.
const theme = Colors.light;

/**
 * What the customer already owed, under the customer it belongs to.
 *
 * Renders nothing when they owe nothing, which is the whole point: a shop that
 * has never given credit never sees this row, and one that has sees it on the
 * customer it applies to rather than as a permanent fixture of the till.
 */
export function CustomerBalanceRow({
  owedCents,
  since,
  saleCount,
  currency,
  collecting,
  onCollect,
}: {
  owedCents: number;
  since: string | null;
  saleCount: number;
  currency: Currency | null;
  collecting: boolean;
  onCollect: () => void;
}) {
  if (owedCents <= 0) return null;

  const secondary = secondaryAmount(owedCents, currency);
  // Same ambient-locale short form the range label uses.
  const sinceLabel = since
    ? new Date(since).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
    : null;

  // "across 1 sale" is noise on the common case, so the count only appears once
  // it is telling the cashier something they could not have assumed.
  const spread = saleCount > 1 ? `across ${saleCount} sales` : null;
  const detail = [sinceLabel ? `since ${sinceLabel}` : null, spread].filter(Boolean).join(' · ');

  return (
    <View style={styles.row}>
      <View style={styles.text}>
        <Text style={styles.owed}>Owes {formatCents(owedCents)}</Text>
        {secondary !== null && <Text style={styles.echo}>{secondary}</Text>}
        {detail.length > 0 && <Text style={styles.detail}>{detail}</Text>}
      </View>

      <Pressable
        onPress={collecting ? undefined : onCollect}
        disabled={collecting}
        accessibilityRole="button"
        style={[styles.action, collecting && styles.actionBusy]}
      >
        <Text style={styles.actionText}>{collecting ? 'Collecting…' : 'Collect it'}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    marginTop: 10,
    padding: 14,
    borderRadius: BENTO_RADIUS_TILE,
    backgroundColor: theme.bentoAccentWash,
  },
  // minWidth: 0 so a long "since ... across n sales" wraps inside the row
  // rather than pushing the button off the edge.
  text: { flexShrink: 1, minWidth: 0 },
  owed: { fontSize: 14, fontWeight: '800', color: theme.bentoAccentInk, fontVariant: ['tabular-nums'] },
  echo: { fontSize: 10, fontWeight: '600', color: theme.bentoAccentInk, marginTop: 1, opacity: 0.85 },
  detail: { fontSize: 11, fontWeight: '600', color: theme.bentoAccentInk, marginTop: 3, opacity: 0.85 },
  action: {
    flexShrink: 0,
    paddingVertical: 9,
    paddingHorizontal: 14,
    borderRadius: 999,
    backgroundColor: theme.bentoInk,
  },
  actionBusy: { opacity: 0.6 },
  actionText: { fontSize: 12.5, fontWeight: '800', color: '#ffffff' },
});
