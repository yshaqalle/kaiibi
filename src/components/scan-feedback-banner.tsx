import { StyleSheet, Text, View } from 'react-native';

import type { ScanFeedback } from '@/lib/barcode';

// The result of the last scan, shown where the cashier is already looking.
//
// A scan gives no inherent feedback -- the item is in their hand, not on the
// screen -- so silence is indistinguishable from a scanner that has stopped
// working. This is the one channel that exists on every platform (haptics are
// native-only, a beep needs an audio asset), so it carries the whole message
// for now and stays the anchor once those are added alongside it.
export function ScanFeedbackBanner({ feedback }: { feedback: ScanFeedback | null }) {
  if (!feedback) return null;
  return (
    <View style={[styles.banner, styles[feedback.tone]]}>
      <Text style={[styles.text, styles[`${feedback.tone}Text`]]} numberOfLines={2}>
        {feedback.message}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: { borderRadius: 10, paddingHorizontal: 12, paddingVertical: 9, marginBottom: 12 },
  text: { fontSize: 12, fontWeight: '700' },
  ok: { backgroundColor: '#E8F5EC' },
  okText: { color: '#1E8E3E' },
  warn: { backgroundColor: '#FDF3E3' },
  warnText: { color: '#9A6400' },
  error: { backgroundColor: '#FBEAE8' },
  errorText: { color: '#C0392B' },
});
