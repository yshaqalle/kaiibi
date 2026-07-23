import { useRouter } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';

// Used by screens that are pushed on top of the owner tab shell (Settings,
// Add/Edit product) rather than living inside it — those have no persistent
// sidebar/bottom-nav, so without this they'd have no way back except the
// browser's own back button.
export function ScreenHeader({ title }: { title: string }) {
  const router = useRouter();

  return (
    <View style={styles.row}>
      <View style={styles.left}>
        <Pressable onPress={() => (router.canGoBack() ? router.back() : router.replace('/dashboard'))} style={styles.navButton}>
          <Text style={styles.navButtonText}>‹ Back</Text>
        </Pressable>
        <Pressable onPress={() => router.replace('/dashboard')} style={styles.navButton}>
          <Text style={styles.navButtonText}>Home</Text>
        </Pressable>
      </View>
      <Text style={styles.title} numberOfLines={1}>{title}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 24, paddingTop: 20, paddingBottom: 16, borderBottomWidth: 1, borderBottomColor: '#ECECEC' },
  left: { flexDirection: 'row', gap: 8 },
  navButton: { paddingVertical: 7, paddingHorizontal: 12, borderRadius: 8, backgroundColor: '#F2F2F2' },
  navButtonText: { fontSize: 12, fontWeight: '700', color: '#111111' },
  title: { flex: 1, fontSize: 17, fontWeight: '800', color: '#111111' },
});
