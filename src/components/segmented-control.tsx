import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Colors } from '@/constants/theme';

// Pinned to the light palette for now — no dark-mode switching yet.
const theme = Colors.light;

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { key: T; label: string }[];
  value: T;
  onChange: (key: T) => void;
}) {
  return (
    <View style={[styles.seg, { backgroundColor: theme.surfaceMuted }]} role="tablist">
      {options.map((option) => {
        const active = option.key === value;
        return (
          <Pressable
            key={option.key}
            onPress={() => onChange(option.key)}
            style={[styles.button, active && { backgroundColor: theme.text }]}
            role="tab"
            aria-selected={active}
          >
            <Text style={[styles.label, { color: active ? theme.background : theme.textSecondary }]}>{option.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

// Equal-width segments in a muted track, but the selected one takes
// AccountingTabBar's colors -- solid black fill, inverted label -- so the two
// tab rows read as the same control.
const styles = StyleSheet.create({
  seg: { flexDirection: 'row', gap: 3, borderRadius: 10, padding: 3, marginBottom: 12 },
  button: { flex: 1, paddingVertical: 7, paddingHorizontal: 4, borderRadius: 8, alignItems: 'center' },
  label: { fontSize: 11.5, fontWeight: '700' },
});
