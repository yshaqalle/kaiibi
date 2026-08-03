import DateTimePicker from '@react-native-community/datetimepicker';
import { useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, type StyleProp, type ViewStyle, View } from 'react-native';

// Web uses the browser's date control; iOS/Android use the platform picker.
// Keeping one component gives every date field the same calendar-first UX.
export function DateInput({
  value,
  onChangeText,
  style,
  minimumDate,
}: {
  value: string;
  onChangeText: (value: string) => void;
  style?: StyleProp<ViewStyle>;
  minimumDate?: string;
}) {
  const [showPicker, setShowPicker] = useState(false);

  if (Platform.OS === 'web') {
    // @ts-ignore — raw DOM element rendered via react-native-web, not a React Native intrinsic
    return <input type="date" value={value} min={minimumDate} onChange={(e: any) => onChangeText(e.target.value)} style={webInputStyle} />;
  }

  const selectedDate = parseDateInput(value) ?? new Date();
  const minDate = minimumDate ? parseDateInput(minimumDate) ?? undefined : undefined;
  return (
    <View>
      <Pressable onPress={() => setShowPicker((visible) => !visible)} style={[styles.input, style]}>
        <Text style={[styles.inputText, !value && styles.placeholder]}>{value || 'Select date'}</Text>
        <Text style={styles.calendarIcon}>▾</Text>
      </Pressable>
      {showPicker && (
        <DateTimePicker
          value={selectedDate}
          mode="date"
          display={Platform.OS === 'ios' ? 'inline' : 'default'}
          minimumDate={minDate}
          onChange={(_event, date) => {
            if (Platform.OS === 'android') setShowPicker(false);
            if (date) onChangeText(formatLocalDate(date));
          }}
        />
      )}
    </View>
  );
}

function formatLocalDate(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

const webInputStyle = {
  backgroundColor: '#F2F2F2',
  borderRadius: 10,
  height: 42,
  paddingLeft: 12,
  paddingRight: 12,
  border: 'none',
  outline: 'none',
  color: '#111111',
  fontSize: 14,
  width: '100%',
  boxSizing: 'border-box',
} as const;

const styles = StyleSheet.create({
  input: { minHeight: 42, backgroundColor: '#F2F2F2', borderRadius: 10, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  inputText: { color: '#111111', fontSize: 14 },
  placeholder: { color: '#999999' },
  calendarIcon: { color: '#666666', fontSize: 15 },
});

export function parseDateInput(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value.trim())) return null;
  const date = new Date(`${value.trim()}T00:00:00`);
  return Number.isNaN(date.getTime()) ? null : date;
}
