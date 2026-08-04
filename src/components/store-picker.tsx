import { StyleSheet, Text, View } from 'react-native';

import { OptionPicker } from '@/components/option-picker';
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
// Renders nothing for a single-store business, where the distinction has no
// content. Presentation is OptionPicker's problem — chips for a handful of
// stores, a dropdown once there are more.
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
      <OptionPicker
        value={value}
        onChange={onChange}
        options={locations.filter((l) => l.active).map((l) => ({ id: l.id, label: l.name, hint: l.code ? `#${l.code}` : undefined }))}
        allOption={{ label: businessWideLabel, hint: 'Belongs to no single store' }}
        title="Which store is this for?"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginTop: 12 },
  label: { color: '#999999', fontSize: 10, fontWeight: '800', letterSpacing: 0.6, marginBottom: 6 },
});
