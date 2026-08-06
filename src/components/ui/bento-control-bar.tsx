import { type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import { OptionPicker } from '@/components/option-picker';
import type { DateRange, RangePreset } from '@/components/range-selector';
import { RangeMenu } from '@/components/ui/range-menu';
import { useAuth } from '@/hooks/use-auth';
import { hasMultipleLocations } from '@/lib/location-selection';

// "Which dates, which store" — the two controls every bento screen carries,
// as a matched pair of pills in the header row.
//
// One component rather than each screen assembling its own, because the
// Dashboard and Accounting previously drifted: Accounting hoisted its store
// filter to the shell while the Dashboard kept its own, and the two rendered
// the same choice in different shapes. Sharing the bar makes them identical by
// construction.
//
// The store pill disappears entirely for a single-store shop — same rule as
// LocationFilterRow, which this replaces on the converted screens.
export function BentoControlBar({
  presets,
  initialDays,
  onRangeChange,
  locationFilter,
  onLocationChange,
  actions,
}: {
  presets: RangePreset[];
  initialDays?: number;
  onRangeChange: (range: DateRange) => void;
  /** null is the combined business view. */
  locationFilter: string | null;
  onLocationChange: (locationId: string | null) => void;
  /** Screen-specific buttons — Export and the like — placed before the pills. */
  actions?: ReactNode;
}) {
  const { locations } = useAuth();
  const multiStore = hasMultipleLocations(locations);

  return (
    <View style={styles.bar}>
      {actions}
      <RangeMenu presets={presets} initialDays={initialDays} onChange={onRangeChange} />
      {multiStore && (
        <OptionPicker
          value={locationFilter}
          onChange={onLocationChange}
          options={locations
            .filter((location) => location.active)
            .map((location) => ({ id: location.id, label: location.name, hint: location.code ? `#${location.code}` : undefined }))}
          allOption={{ label: 'All stores', hint: 'Every store combined' }}
          title="Show figures for"
          // Forced to the dropdown so it matches the range pill beside it. As
          // chips, a three-store shop would show one control as a pill and the
          // other as a row, in the same bar.
          chipLimit={0}
          variant="bento"
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
});
