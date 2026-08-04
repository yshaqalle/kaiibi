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
  // `false` drops the "All stores" option, for places where the answer must be
  // one store — opening stock has to land somewhere in particular, and "all"
  // would be a value the write path can't honour.
  allowAll = true,
  title = 'Show stock for',
  placeholder = 'Choose a store',
  // 'field' fills the width and matches the form inputs beside it; 'compact'
  // sits in a header row next to the export buttons.
  variant = 'compact',
}: {
  value: string | null;
  onChange: (locationId: string | null) => void;
  allowAll?: boolean;
  title?: string;
  placeholder?: string;
  variant?: 'compact' | 'field';
}) {
  const { locations } = useAuth();
  const [open, setOpen] = useState(false);

  if (!hasMultipleLocations(locations)) return null;

  const selectable = locations.filter((location) => location.active);
  const selected = value === null ? undefined : selectable.find((l) => l.id === value);
  const label = selected?.name ?? (allowAll ? 'All stores' : placeholder);

  return (
    <>
      <Pressable
        onPress={() => setOpen(true)}
        style={[styles.trigger, variant === 'field' ? styles.triggerField : styles.triggerCompact]}
      >
        <Text
          style={[
            styles.triggerText,
            variant === 'field' ? styles.triggerTextField : styles.triggerTextCompact,
            variant === 'field' && !selected && !allowAll && styles.triggerPlaceholder,
          ]}
          numberOfLines={1}
        >
          {label}
        </Text>
        <Text style={[styles.chevron, variant !== 'field' && styles.chevronCompact]}>▾</Text>
      </Pressable>

      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable style={styles.backdrop} onPress={() => setOpen(false)}>
          <View style={styles.sheet}>
            <Text style={styles.sheetTitle}>{title}</Text>
            <ScrollView style={styles.list}>
              {allowAll && (
                <Option
                  label="All stores"
                  hint="Every store combined"
                  selected={value === null}
                  onPress={() => {
                    onChange(null);
                    setOpen(false);
                  }}
                />
              )}
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
        {/* Ternary, not `hint && …`: hint is a string, and an empty one would
            render as a bare text node inside a View — a hard error on RN Web. */}
        {hint ? <Text style={styles.optionHint}>{hint}</Text> : null}
      </View>
      {selected && <Text style={styles.check}>✓</Text>}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  trigger: { flexDirection: 'row', alignItems: 'center', gap: 6, borderRadius: 10 },
  // Matches the export/import/add buttons it sits beside — same black, radius,
  // padding and 11/800 label, so the header reads as one row of actions.
  triggerCompact: { backgroundColor: '#111111', paddingHorizontal: 12, paddingVertical: 9, maxWidth: 170 },
  // In a form it is an input, not an action, so it matches the fields around it.
  triggerField: { backgroundColor: '#F2F2F2', alignSelf: 'stretch', justifyContent: 'space-between', height: 42, paddingHorizontal: 12 },
  triggerText: { flexShrink: 1 },
  triggerTextCompact: { fontSize: 11, fontWeight: '800', color: '#FFFFFF' },
  triggerTextField: { fontSize: 13, fontWeight: '600', color: '#111111' },
  triggerPlaceholder: { color: '#999999' },
  chevron: { fontSize: 10, color: '#111111' },
  chevronCompact: { color: '#FFFFFF' },
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
