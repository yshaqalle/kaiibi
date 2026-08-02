import { StyleSheet, Text, View } from 'react-native';

export type BadgeTone = 'default' | 'success' | 'warning' | 'danger';

// Static status pill -- VIP/Regular/New/At-risk on Customers rows, Active/
// On-leave on Team rows (Tasks 11, 12). Distinct from CategoryChip, which
// is an interactive/toggleable filter control, the wrong affordance here.
const TONE_COLORS: Record<BadgeTone, { background: string; text: string }> = {
  default: { background: '#EAEAEA', text: '#555555' },
  success: { background: '#E1F0E4', text: '#2E7D46' },
  warning: { background: '#F8EEDA', text: '#9A6B0C' },
  danger: { background: '#F7E1E2', text: '#B23B4E' },
};

export function Badge({ label, tone = 'default' }: { label: string; tone?: BadgeTone }) {
  const colors = TONE_COLORS[tone];
  return (
    <View style={[styles.badge, { backgroundColor: colors.background }]}>
      <Text style={[styles.text, { color: colors.text }]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: { paddingHorizontal: 9, paddingVertical: 4, borderRadius: 999, alignSelf: 'flex-start' },
  text: { fontSize: 10.5, fontWeight: '700', letterSpacing: 0.2 },
});
