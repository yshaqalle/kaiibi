import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import {
  DAY_LABELS,
  WEEK_ORDER,
  isValidTime,
  rangesFor,
  type OpeningHours,
  type WeekdayKey,
} from '@/lib/store-hours';

// Seven rows, one per weekday. The stored shape allows several ranges a day,
// but this editor offers one or Closed -- see the spec: the list shape exists
// so a lunch or prayer closure can be added later without touching the column
// or its readers.
//
// Times are plain text inputs validated against 'HH:MM', matching how DateInput
// handles dates in this codebase rather than introducing a picker.

const DEFAULT_RANGE = { open: '09:00', close: '18:00' };

function setDay(hours: OpeningHours, day: WeekdayKey, ranges: { open: string; close: string }[]): OpeningHours {
  return { ...hours, [day]: ranges };
}

function DayRow({
  day,
  hours,
  onChange,
}: {
  day: WeekdayKey;
  hours: OpeningHours;
  onChange: (next: OpeningHours) => void;
}) {
  const ranges = rangesFor(hours, day);
  const range = ranges[0];
  const closed = range === undefined;

  return (
    <View style={styles.row}>
      <Text style={styles.day}>{DAY_LABELS[day]}</Text>
      {closed ? (
        <>
          <Text style={styles.closed}>Closed</Text>
          <Pressable onPress={() => onChange(setDay(hours, day, [DEFAULT_RANGE]))}>
            <Text style={styles.action}>Set hours</Text>
          </Pressable>
        </>
      ) : (
        <>
          <TextInput
            value={range.open}
            onChangeText={(open) => onChange(setDay(hours, day, [{ ...range, open }]))}
            placeholder="09:00"
            placeholderTextColor="#999999"
            style={[styles.time, !isValidTime(range.open) && styles.timeInvalid]}
          />
          <Text style={styles.dash}>–</Text>
          <TextInput
            value={range.close}
            onChangeText={(close) => onChange(setDay(hours, day, [{ ...range, close }]))}
            placeholder="18:00"
            placeholderTextColor="#999999"
            style={[styles.time, !isValidTime(range.close) && styles.timeInvalid]}
          />
          <Pressable onPress={() => onChange(setDay(hours, day, []))}>
            <Text style={styles.action}>Close</Text>
          </Pressable>
        </>
      )}
    </View>
  );
}

export function OpeningHoursEditor({ value, onChange }: { value: OpeningHours; onChange: (next: OpeningHours) => void }) {
  return (
    <View>
      {WEEK_ORDER.map((day) => (
        <DayRow key={day} day={day} hours={value} onChange={onChange} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: '#F2F2F2' },
  day: { fontSize: 13, fontWeight: '700', color: '#111111', width: 92 },
  closed: { fontSize: 13, color: '#999999', flex: 1 },
  time: { backgroundColor: '#F2F2F2', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, fontSize: 13, color: '#111111', width: 72, textAlign: 'center' },
  timeInvalid: { borderWidth: 1, borderColor: '#C0392B', color: '#C0392B' },
  dash: { fontSize: 13, color: '#999999' },
  action: { fontSize: 12, fontWeight: '700', color: '#111111', marginLeft: 'auto' },
});
