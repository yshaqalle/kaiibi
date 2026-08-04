import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useAuth } from '@/hooks/use-auth';
import { hasMultipleLocations } from '@/lib/location-selection';

// "All stores" plus one chip per store, for the accounting tabs.
//
// `null` is the combined business view — everything, including costs that
// belong to no single store. That is what these screens showed before stores
// existed, so it stays the default and a single-store shop sees no change
// (this renders nothing at all for one store).
//
// Note the asymmetry with picking a store: the combined view INCLUDES
// business-wide rows, while a per-store view excludes them. The per-store
// figures therefore do not sum to the combined one, and the difference is the
// unattributed overhead — see lib/location-reporting.ts.
export function LocationFilterRow({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (locationId: string | null) => void;
}) {
  const { locations } = useAuth();
  if (!hasMultipleLocations(locations)) return null;

  return (
    <View style={styles.row}>
      <Pressable onPress={() => onChange(null)} style={[styles.chip, value === null && styles.chipActive]}>
        <Text style={[styles.chipText, value === null && styles.chipTextActive]}>All stores</Text>
      </Pressable>
      {locations
        .filter((location) => location.active)
        .map((location) => (
          <Pressable
            key={location.id}
            onPress={() => onChange(location.id)}
            style={[styles.chip, value === location.id && styles.chipActive]}
          >
            <Text style={[styles.chipText, value === location.id && styles.chipTextActive]}>{location.name}</Text>
          </Pressable>
        ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 14 },
  chip: { backgroundColor: '#F2F2F2', borderRadius: 999, paddingHorizontal: 12, paddingVertical: 7 },
  chipActive: { backgroundColor: '#111111' },
  chipText: { fontSize: 12, fontWeight: '700', color: '#111111' },
  chipTextActive: { color: '#FFFFFF' },
});
