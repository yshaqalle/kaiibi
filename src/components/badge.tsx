import { StyleSheet, Text, View } from 'react-native';

import { Colors } from '@/constants/theme';

const theme = Colors.light;

export type BadgeTone = 'default' | 'success' | 'warning' | 'danger' | 'refund' | 'info';

// Static status pill -- VIP/Regular/New/At-risk on Customers rows, Active/
// On-leave on Team rows (Tasks 11, 12). Distinct from CategoryChip, which
// is an interactive/toggleable filter control, the wrong affordance here.
const TONE_COLORS: Record<BadgeTone, { background: string; text: string }> = {
  default: { background: '#EAEAEA', text: '#555555' },
  success: { background: '#E1F0E4', text: '#2E7D46' },
  warning: { background: '#F8EEDA', text: '#9A6B0C' },
  danger: { background: '#F7E1E2', text: '#B23B4E' },
  // Cream-palette steps for the two tones the bento set introduces, so an
  // unconverted screen can still use them without borrowing bento tokens --
  // the two palettes are kept apart on purpose.
  refund: { background: '#F8EEDA', text: '#9A6B0C' },
  info: { background: '#E4EAF6', text: '#3A5A94' },
};

// The bento set. Only `default` really changes character -- its warm grey read
// as a smudge on a cool-grey card. The three status tones stay warm on purpose:
// warning and danger are SUPPOSED to be warmer than their surroundings, and
// cooling them to match the palette would cost them the alarm they carry.
const TONE_COLORS_BENTO: Record<BadgeTone, { background: string; text: string }> = {
  default: { background: theme.bentoSoft, text: theme.bentoInk2 },
  success: { background: '#E7F5ED', text: '#0B6B3C' },
  warning: { background: '#FDF1E3', text: '#8A530F' },
  danger: { background: '#FCE9EB', text: '#B0293A' },
  // The only two that read tokens rather than literals. Both were solved
  // against their own wash the way the delta pills were, so they are named in
  // theme.ts where that solve is recorded -- see `bentoRefundInk`.
  refund: { background: theme.bentoRefundWash, text: theme.bentoRefundInk },
  info: { background: theme.bentoAccentWash, text: theme.bentoAccentInk },
};

export function Badge({
  label,
  tone = 'default',
  variant = 'default',
}: {
  label: string;
  tone?: BadgeTone;
  variant?: 'default' | 'bento';
}) {
  const colors = (variant === 'bento' ? TONE_COLORS_BENTO : TONE_COLORS)[tone];
  return (
    <View style={[styles.badge, { backgroundColor: colors.background }]}>
      <Text style={[styles.text, { color: colors.text }]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: { paddingHorizontal: 9, paddingVertical: 4, borderRadius: 999, alignSelf: 'center' },
  text: { fontSize: 10.5, fontWeight: '700', letterSpacing: 0.2 },
});
