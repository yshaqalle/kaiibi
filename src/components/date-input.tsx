import { Platform, StyleSheet, TextInput, type StyleProp, type TextStyle } from 'react-native';

// A native `<input type="date">` gives web its built-in calendar popup for
// free — no date-picker dependency needed. react-native-web renders straight
// to the DOM, so this raw element works fine at runtime; TypeScript just
// doesn't know 'input' as an intrinsic element in this project's JSX
// namespace, hence the ts-ignore. Native has no equivalent without adding
// @react-native-community/datetimepicker (a real native dependency requiring
// a rebuild), so it falls back to the existing plain-text YYYY-MM-DD entry.
export function DateInput({ value, onChangeText, style }: { value: string; onChangeText: (value: string) => void; style?: StyleProp<TextStyle> }) {
  if (Platform.OS === 'web') {
    // @ts-ignore — raw DOM element rendered via react-native-web, not a React Native intrinsic
    return <input type="date" value={value} onChange={(e: any) => onChangeText(e.target.value)} style={webInputStyle} />;
  }
  return <TextInput value={value} onChangeText={onChangeText} placeholder="YYYY-MM-DD" placeholderTextColor="#999999" style={[styles.input, style]} />;
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
  input: { backgroundColor: '#F2F2F2', borderRadius: 10, height: 42, paddingHorizontal: 12, color: '#111111' },
});
