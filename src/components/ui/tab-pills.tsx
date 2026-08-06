import { Pressable, ScrollView, StyleSheet, Text } from 'react-native';

import { Colors } from '@/constants/theme';

// Pinned to the light palette for now — no dark-mode switching yet.
const theme = Colors.light;

// The scrolling pill row the bento screens use to switch tabs.
//
// Same {options, value, onChange} contract as SegmentedControl, but each pill
// is its own width and the row scrolls, rather than every option getting an
// equal `flex: 1` share. That is what makes seven of them workable on a phone
// -- at equal flex, Accounting's seven collapse to ~14% each and clip
// "Transactions" and "Cash & Budgets".
//
// Lives in ui/ rather than accounting/ because People uses it too; the two
// screens have to agree on what a tab looks like. accounting-tab-bar.tsx is
// kept as a re-export so Accounting's own imports did not have to move.
export function TabPills<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { key: T; label: string }[];
  value: T;
  onChange: (key: T) => void;
}) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.row}
      // Without this the row stretches to the tallest thing in the parent and
      // the pills float in the middle of the empty space.
      style={styles.scroll}
      role="tablist"
    >
      {options.map((option) => {
        const active = option.key === value;
        return (
          <Pressable
            key={option.key}
            onPress={() => onChange(option.key)}
            style={[styles.pill, active && styles.pillActive]}
            role="tab"
            aria-selected={active}
          >
            <Text style={[styles.label, active && styles.labelActive]}>{option.label}</Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { flexGrow: 0 },
  row: { flexDirection: 'row', gap: 6, paddingBottom: 2 },
  pill: {
    borderWidth: 1,
    borderColor: theme.bentoLine,
    backgroundColor: theme.bentoSurface,
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 999,
  },
  pillActive: { backgroundColor: theme.bentoInk, borderColor: theme.bentoInk },
  label: { fontSize: 12.5, fontWeight: '700', color: theme.bentoMuted },
  labelActive: { color: theme.bentoSurface },
});
