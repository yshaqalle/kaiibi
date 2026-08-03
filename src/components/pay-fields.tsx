import { StyleSheet, Text, TextInput, View } from 'react-native';

import { CategoryChip } from '@/components/category-chip';
import { formatPayRateLong, rateInputToCents, type RateEntryUnit } from '@/lib/pay-rate';
import type { PayCadence } from '@/lib/pay-periods';
import type { StaffMember } from '@/types/models';

// The pay form, shared by the two modals that can edit pay. It was duplicated
// verbatim in both; adding the entry-unit control would have tripled that.
//
// The live "$3,000.00 / month · $36,000.00 / year" line under the input is the
// point of this component, not decoration: a bare number with no unit is the
// bug this whole change exists to remove, and showing both figures as they
// type is what stops it coming back.

export type PayFieldsValue = {
  payType: StaffMember['payType'];
  rate: string;
  entryUnit: RateEntryUnit;
  payCadence: PayCadence;
};

const PAY_TYPES = ['hourly', 'salary', 'fixed'] as const;
const ENTRY_UNITS: { unit: RateEntryUnit; label: string }[] = [
  { unit: 'weekly', label: 'Week' },
  { unit: 'monthly', label: 'Month' },
  { unit: 'yearly', label: 'Year' },
];
const CADENCES: { cadence: PayCadence; label: string }[] = [
  { cadence: 'weekly', label: 'Weekly' },
  { cadence: 'biweekly', label: 'Every 2 weeks' },
  { cadence: 'semimonthly', label: 'Twice a month' },
  { cadence: 'monthly', label: 'Monthly' },
];

// Stored rates are already monthly, so an existing member always opens on
// Month -- what they see is exactly what is stored.
export function payFieldsInitial(member: StaffMember): PayFieldsValue {
  return {
    payType: member.payType,
    rate: member.payRateCents != null ? (member.payRateCents / 100).toString() : '',
    entryUnit: 'monthly',
    payCadence: member.payCadence,
  };
}

export function payFieldsToCents(value: PayFieldsValue): number | null {
  return rateInputToCents(value.rate, value.payType, value.entryUnit);
}

export function PayFields({
  value,
  onChange,
}: {
  value: PayFieldsValue;
  onChange: (next: PayFieldsValue) => void;
}) {
  const monthlyPreview = payFieldsToCents(value);
  // toCents (which this delegates to) never fails to parse -- unparseable
  // text like "abc" quietly collapses to 0 rather than null or NaN. A rate of
  // 0 is never a real entry, so treating it as "not worth previewing yet" is
  // the same gate callers use to validate before saving.
  const hasPreviewableRate = value.rate.trim() !== '' && monthlyPreview !== null && monthlyPreview > 0;

  return (
    <View>
      <Text style={styles.label}>PAY TYPE</Text>
      <View style={styles.chips}>
        {PAY_TYPES.map((type) => (
          <CategoryChip
            key={type}
            label={type[0].toUpperCase() + type.slice(1)}
            active={value.payType === type}
            onPress={() => onChange({ ...value, payType: type })}
          />
        ))}
      </View>

      <Text style={styles.label}>PAY RATE (DOLLARS)</Text>
      <TextInput
        value={value.rate}
        onChangeText={(rate) => onChange({ ...value, rate })}
        keyboardType="decimal-pad"
        placeholder={value.payType === 'hourly' ? 'e.g. 8.50' : 'e.g. 3000'}
        placeholderTextColor="#999999"
        style={styles.input}
      />

      {/* Salary is the only type with an ambiguous unit -- hourly is per hour
          and fixed is per pay run, both by definition. */}
      {value.payType === 'salary' && (
        <>
          <Text style={styles.label}>AMOUNT ENTERED IS PER</Text>
          <View style={styles.chips}>
            {ENTRY_UNITS.map(({ unit, label }) => (
              <CategoryChip
                key={unit}
                label={label}
                active={value.entryUnit === unit}
                onPress={() => onChange({ ...value, entryUnit: unit })}
              />
            ))}
          </View>
        </>
      )}

      {/* Applies to every pay type -- cadence is when someone is paid, not
          what they're paid. */}
      <Text style={styles.label}>PAID</Text>
      <View style={styles.chips}>
        {CADENCES.map(({ cadence, label }) => (
          <CategoryChip
            key={cadence}
            label={label}
            active={value.payCadence === cadence}
            onPress={() => onChange({ ...value, payCadence: cadence })}
          />
        ))}
      </View>

      {hasPreviewableRate && (
        <Text style={styles.preview}>{formatPayRateLong(value.payType, monthlyPreview)}</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  label: { color: '#999999', fontSize: 10, fontWeight: '800', letterSpacing: 0.6, marginTop: 12, marginBottom: 6 },
  input: { backgroundColor: '#F2F2F2', height: 42, borderRadius: 10, paddingHorizontal: 12, color: '#111111' },
  chips: { flexDirection: 'row', gap: 8, paddingBottom: 2 },
  preview: { color: '#444444', fontSize: 12, fontWeight: '700', marginTop: 8 },
});
