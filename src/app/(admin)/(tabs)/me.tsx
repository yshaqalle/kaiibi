import { StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

// Self-service HR -- Task 13 replaces this body with the clock in/out
// widget, recent shifts, time-off request+history, and pay display. This
// skeleton exists so the routing/nav/permission-matrix wiring in Task 10
// can be verified end-to-end before that content lands. Route-level access
// is deliberately NOT gated by a Permission -- see (admin)/_layout.tsx
// (Task 7) and src/lib/permissions.ts's ROUTE_PERMISSIONS comment (Task 6):
// any active shop_members row (or the admin) can reach this tab.
export default function MeScreen() {
  return (
    <SafeAreaView edges={['left', 'right', 'bottom']} style={styles.safeArea}>
      <View style={styles.header}>
        <Text style={styles.title}>Me</Text>
      </View>
      <Text style={styles.placeholder}>Self-service HR — coming in Task 13.</Text>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#FFFFFF' },
  header: { paddingHorizontal: 24, paddingTop: 24 },
  title: { color: '#111111', fontSize: 24, fontWeight: '800', letterSpacing: -0.5 },
  placeholder: { paddingHorizontal: 24, paddingTop: 14, color: '#999999', fontSize: 13 },
});
