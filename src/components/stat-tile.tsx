import { StyleSheet, Text, View } from 'react-native';

export function StatTile({ value, label }: { value: string; label: string }) {
  return (
    <View style={styles.tile}>
      <Text style={styles.value}>{value}</Text>
      <Text style={styles.label}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  tile: { flex: 1, minHeight: 90, padding: 14, borderRadius: 12, borderWidth: 1, borderColor: '#EDEDED', backgroundColor: '#FFFFFF', justifyContent: 'flex-end' },
  value: { color: '#111111', fontSize: 22, letterSpacing: -1, fontWeight: '800' },
  label: { marginTop: 4, color: '#999999', fontSize: 11, lineHeight: 14 },
});
