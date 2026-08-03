import { Pressable, ScrollView, StyleSheet, Text } from 'react-native';

import { Colors } from '@/constants/theme';

// Pinned to the light palette for now — no dark-mode switching yet, matching
// SegmentedControl and RangeSelector.
const theme = Colors.light;

// Same {options, value, onChange} contract as SegmentedControl, but scrollable
// rather than equal-flex. SegmentedControl gives each option `flex: 1`, which
// is right for the 2-3 options it's used for elsewhere (People's sub-tabs,
// the dashboard's sections) but collapses Accounting's seven to ~14% each --
// enough to clip "Transactions" and "Cash & Budgets". Here each pill is its
// own width and the row scrolls, which is also what makes seven workable on a
// phone.
export function AccountingTabBar<T extends string>({
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
            style={[
              styles.pill,
              { borderColor: theme.border },
              active && { backgroundColor: theme.text, borderColor: theme.text },
            ]}
            role="tab"
            aria-selected={active}
          >
            <Text style={[styles.label, { color: active ? theme.background : theme.textSecondary }]}>{option.label}</Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { flexGrow: 0 },
  row: { flexDirection: 'row', gap: 6, paddingBottom: 2 },
  pill: { borderWidth: 1, paddingVertical: 8, paddingHorizontal: 14, borderRadius: 999 },
  label: { fontSize: 12.5, fontWeight: '700' },
});
