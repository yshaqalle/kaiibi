import { StyleSheet, View } from 'react-native';

import { OptionPicker } from '@/components/option-picker';
import { useAuth } from '@/hooks/use-auth';
import { hasMultipleLocations } from '@/lib/location-selection';

// Which store an accounting tab is showing.
//
// `null` is the combined business view — everything, including costs that
// belong to no single store. That is what these screens showed before stores
// existed, so it stays the default and a single-store shop sees nothing here.
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
      <OptionPicker
        value={value}
        onChange={onChange}
        options={locations.filter((l) => l.active).map((l) => ({ id: l.id, label: l.name, hint: l.code ? `#${l.code}` : undefined }))}
        allOption={{ label: 'All stores', hint: 'Every store combined' }}
        title="Show figures for"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  row: { marginBottom: 14 },
});
