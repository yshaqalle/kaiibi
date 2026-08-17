import { Pressable, StyleSheet, Text, View } from 'react-native';

import { BENTO_RADIUS_TILE, Colors } from '@/constants/theme';
import { formatCents } from '@/lib/currency';
import { secondaryAmount } from '@/lib/display-currency';
import type { Currency } from '@/types/models';

// Pinned to the light palette for now -- no dark-mode switching yet.
const theme = Colors.light;

export type RestChoiceValue = 'now' | 'later';

/**
 * What happens to the part of the bill the payments do not cover.
 *
 * Renders nothing at all when there is nothing left over, which is every
 * ordinary sale -- a shop that never gives credit never meets this control. It
 * appears because money is missing, and disappears the moment it isn't.
 */
export function RestChoice({
  remainingCents,
  choice,
  hasCustomer,
  currency,
  onChange,
}: {
  remainingCents: number;
  choice: RestChoiceValue;
  hasCustomer: boolean;
  currency: Currency | null;
  onChange: (choice: RestChoiceValue) => void;
}) {
  if (remainingCents <= 0) return null;

  const secondary = secondaryAmount(remainingCents, currency);

  return (
    <View>
      <Text style={styles.heading}>THE REMAINING {formatCents(remainingCents)}</Text>
      {secondary !== null && <Text style={styles.headingEcho}>{secondary}</Text>}

      <View style={styles.row}>
        <Tile
          label="Collect it now"
          detail="Take the rest before they go"
          active={choice === 'now'}
          onPress={() => onChange('now')}
        />
        <Tile
          label="Pay later"
          // The server refuses a nameless debt outright, so this is not a
          // nudge -- it is the same rule, said before the customer is waiting.
          detail={hasCustomer ? 'Carried on their account' : 'Needs a customer'}
          active={choice === 'later'}
          disabled={!hasCustomer}
          onPress={() => onChange('later')}
        />
      </View>
    </View>
  );
}

function Tile({
  label,
  detail,
  active,
  disabled = false,
  onPress,
}: {
  label: string;
  detail: string;
  active: boolean;
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={disabled ? undefined : onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityState={{ selected: active, disabled }}
      style={[styles.tile, active && styles.tileActive, disabled && styles.tileDisabled]}
    >
      <Text style={[styles.tileLabel, active && styles.tileLabelActive, disabled && styles.tileLabelDisabled]}>
        {label}
      </Text>
      <Text style={[styles.tileDetail, active && styles.tileDetailActive, disabled && styles.tileLabelDisabled]}>
        {detail}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  heading: { fontSize: 12, fontWeight: '700', color: theme.bentoMuted, letterSpacing: 0.4, marginTop: 22 },
  headingEcho: { fontSize: 10, fontWeight: '600', color: theme.bentoMuted2, marginTop: 2 },
  row: { flexDirection: 'row', gap: 10, marginTop: 10 },
  tile: {
    flexGrow: 1,
    flexBasis: '47%',
    // Yoga defaults minWidth to auto, so without this the longer label widens
    // the pair instead of wrapping inside it.
    minWidth: 0,
    padding: 14,
    borderRadius: BENTO_RADIUS_TILE,
    backgroundColor: theme.bentoSoft,
  },
  // The accent wash is the "this is chosen" signal everywhere else in bento; it
  // is not a status colour, so it carries no good/bad meaning here.
  tileActive: { backgroundColor: theme.bentoAccentWash },
  tileDisabled: { opacity: 0.55 },
  tileLabel: { fontSize: 14, fontWeight: '800', color: theme.bentoInk },
  tileLabelActive: { color: theme.bentoAccentInk },
  tileLabelDisabled: { color: theme.bentoMuted2 },
  tileDetail: { fontSize: 11, fontWeight: '600', color: theme.bentoMuted, marginTop: 3, lineHeight: 15 },
  tileDetailActive: { color: theme.bentoAccentInk },
});
