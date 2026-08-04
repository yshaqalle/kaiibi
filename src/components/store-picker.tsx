import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { CategoryChip } from '@/components/category-chip';
import { useAuth } from '@/hooks/use-auth';
import { hasMultipleLocations } from '@/lib/location-selection';

// Which store a cost, bill or budget belongs to.
//
// `null` is "business-wide" and is a REAL choice, not an empty one: rent for
// head office, a licence covering every store, a campaign for the whole
// business. Per-store reporting excludes those; business-wide reporting
// includes them. Forcing every cost onto a store would quietly inflate that
// store's expenses and flatter the others (migration 20260816000000).
//
// Renders nothing for a single-store business, which is the norm — there the
// distinction has no content, and the row would be a question with one answer.
export function StorePicker({
  value,
  onChange,
  label = 'STORE',
  businessWideLabel = 'Business-wide',
}: {
  value: string | null;
  onChange: (locationId: string | null) => void;
  label?: string;
  businessWideLabel?: string;
}) {
  const { locations } = useAuth();
  if (!hasMultipleLocations(locations)) return null;

  return (
    <View style={styles.wrap}>
      <Text style={styles.label}>{label}</Text>
      <ScrollView horizontal contentContainerStyle={styles.chips} showsHorizontalScrollIndicator={false}>
        <CategoryChip label={businessWideLabel} active={value === null} onPress={() => onChange(null)} />
        {locations
          .filter((location) => location.active)
          .map((location) => (
            <CategoryChip
              key={location.id}
              label={location.name}
              active={value === location.id}
              onPress={() => onChange(location.id)}
            />
          ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginTop: 12 },
  label: { color: '#999999', fontSize: 10, fontWeight: '800', letterSpacing: 0.6, marginBottom: 6 },
  chips: { flexDirection: 'row', gap: 6, paddingRight: 8 },
});
