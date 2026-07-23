import { StyleSheet, Text, View } from 'react-native';

export function MetricTile({ value, label, tone }: { value: string; label: string; tone: string }) {
  return (
    <View style={[styles.metric, { backgroundColor: tone }]}>
      <Text style={styles.value}>{value}</Text>
      <Text style={styles.label}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  metric: { flex: 1, minHeight: 103, padding: 13, borderRadius: 14, justifyContent: 'flex-end' },
  value: { color: '#17261F', fontSize: 22, letterSpacing: -1, fontWeight: '800' },
  label: { marginTop: 4, color: '#526058', fontSize: 11, lineHeight: 14 },
});
