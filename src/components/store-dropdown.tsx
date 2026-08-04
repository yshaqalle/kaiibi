import { useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { useAuth } from '@/hooks/use-auth';
import { hasMultipleLocations } from '@/lib/location-selection';

// Which store a list is showing, as a dropdown rather than a chip row — it sits
// in a header beside the export buttons, where a row of chips would push the
// actions off a narrow screen once a business has four or five stores.
//
// `null` is "All stores" and is the default: it is what this screen showed
// before stores existed, so a business that has just added its second one sees
// the same numbers until it chooses otherwise. Renders nothing for a
// single-store business.
export function StoreDropdown({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (locationId: string | null) => void;
}) {
  const { locations } = useAuth();
  const [open, setOpen] = useState(false);

  if (!hasMultipleLocations(locations)) return null;

  const selectable = locations.filter((location) => location.active);
  const label = value === null ? 'All stores' : (selectable.find((l) => l.id === value)?.name ?? 'All stores');

  return (
    <>
      <Pressable onPress={() => setOpen(true)} style={styles.trigger}>
        <Text style={styles.triggerText} numberOfLines={1}>{label}</Text>
        <Text style={styles.chevron}>▾</Text>
      </Pressable>

      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable style={styles.backdrop} onPress={() => setOpen(false)}>
          <View style={styles.sheet}>
            <Text style={styles.sheetTitle}>Show stock for</Text>
            <ScrollView style={styles.list}>
              <Option
                label="All stores"
                hint="Every store combined"
                selected={value === null}
                onPress={() => {
                  onChange(null);
                  setOpen(false);
                }}
              />
              {selectable.map((location) => (
                <Option
                  key={location.id}
                  label={location.name}
                  hint={location.code ? `#${location.code}` : undefined}
                  selected={value === location.id}
                  onPress={() => {
                    onChange(location.id);
                    setOpen(false);
                  }}
                />
              ))}
            </ScrollView>
          </View>
        </Pressable>
      </Modal>
    </>
  );
}

function Option({
  label,
  hint,
  selected,
  onPress,
}: {
  label: string;
  hint?: string;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable onPress={onPress} style={[styles.option, selected && styles.optionSelected]}>
      <View style={styles.optionText}>
        <Text style={styles.optionLabel}>{label}</Text>
        {hint && <Text style={styles.optionHint}>{hint}</Text>}
      </View>
      {selected && <Text style={styles.check}>✓</Text>}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  trigger: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#F2F2F2',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 9,
    maxWidth: 170,
  },
  triggerText: { fontSize: 11, fontWeight: '800', color: '#111111', flexShrink: 1 },
  chevron: { fontSize: 10, color: '#111111' },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', alignItems: 'center', justifyContent: 'center', padding: 20 },
  sheet: { backgroundColor: '#FFFFFF', borderRadius: 18, padding: 20, width: '100%', maxWidth: 420, maxHeight: '70%' },
  sheetTitle: { fontSize: 16, fontWeight: '800', color: '#111111', marginBottom: 12 },
  list: { flexGrow: 0 },
  option: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, paddingVertical: 12, paddingHorizontal: 12, borderRadius: 10 },
  optionSelected: { backgroundColor: '#F2F2F2' },
  optionText: { flex: 1 },
  optionLabel: { fontSize: 14, fontWeight: '700', color: '#111111' },
  optionHint: { fontSize: 12, color: '#9CA3AF', marginTop: 2 },
  check: { fontSize: 14, fontWeight: '800', color: '#111111' },
});
