import { useRouter } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Colors } from '@/constants/theme';

// Used by screens that are pushed on top of the owner tab shell (Settings,
// Add/Edit product) rather than living inside it — those have no persistent
// sidebar/bottom-nav, so without this they'd have no way back except the
// browser's own back button. Always dark (matching OwnerTabs' header and the
// marketing site's black header/footer) regardless of system color scheme —
// this is fixed shell chrome, not a dark-mode toggle. It also owns the top
// safe-area inset itself (paints black behind the status bar), so screens
// using it should exclude 'top' from their own SafeAreaView edges.
export function ScreenHeader({ title }: { title: string }) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const colors = Colors.dark;

  return (
    <View style={[styles.row, { paddingTop: insets.top + 16, backgroundColor: colors.background, borderBottomColor: colors.backgroundElement }]}>
      <Text style={[styles.title, { color: colors.text }]} numberOfLines={1}>{title}</Text>
      <View style={styles.right}>
        <Pressable onPress={() => (router.canGoBack() ? router.back() : router.replace('/dashboard'))} style={[styles.navButton, { backgroundColor: colors.backgroundElement }]}>
          <Text style={[styles.navButtonText, { color: colors.text }]}>‹ Back</Text>
        </Pressable>
        <Pressable onPress={() => router.replace('/dashboard')} style={[styles.navButton, { backgroundColor: colors.backgroundElement }]}>
          <Text style={[styles.navButtonText, { color: colors.text }]}>Home</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 24, paddingBottom: 16, borderBottomWidth: 1 },
  right: { flexDirection: 'row', gap: 8 },
  navButton: { paddingVertical: 7, paddingHorizontal: 12, borderRadius: 8 },
  navButtonText: { fontSize: 12, fontWeight: '700' },
  title: { flex: 1, fontSize: 17, fontWeight: '800' },
});
