import { StyleSheet, Text, View } from 'react-native';

export function RevenueChart({ data }: { data: { day: string; totalCents: number }[] }) {
  const max = Math.max(1, ...data.map((point) => point.totalCents));
  return (
    <View style={styles.chart}>
      {data.map((point) => (
        <View key={point.day} style={styles.column}>
          <View style={[styles.bar, { height: Math.max(4, (point.totalCents / max) * 100) }]} />
          <Text style={styles.dayLabel}>{new Date(point.day).toLocaleDateString(undefined, { weekday: 'short' })[0]}</Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  chart: { flexDirection: 'row', alignItems: 'flex-end', gap: 8, height: 130, paddingHorizontal: 4 },
  column: { flex: 1, alignItems: 'center' },
  bar: { width: '100%', backgroundColor: '#E45B37', borderRadius: 4 },
  dayLabel: { color: '#7B837C', fontSize: 10, marginTop: 6, fontWeight: '700' },
});
