import { useRouter } from 'expo-router';
import { Pressable, SafeAreaView, StyleSheet, Text, View } from 'react-native';

import { signOut } from '@/lib/auth';

// WHERE A SIGNED-IN CUSTOMER LANDS, and it used to be a dead end.
//
// `(public)/_layout.tsx` redirects a session whose profile role is 'customer'
// here, because there was nothing else for them: no admin area, no shop, and
// no marketplace. So this screen said "coming soon" and offered one control,
// Log out.
//
// The marketplace now exists at /store. This screen keeps its route and its
// redirect -- pointing the layout straight at /store would strand a signed-in
// customer, because /store is a PUBLIC page with no session UI on it at all,
// and Log out below is the only sign-out this role has anywhere in the app.
// So it becomes the doorway rather than the wall: browse the shops, or leave.
//
// The copy changed for the same reason the route did. "Coming soon" was true
// when nothing was there and is a plain falsehood now that a customer can tap
// through to real shops.
export default function MarketplaceComingSoonScreen() {
  const router = useRouter();
  return <SafeAreaView style={styles.safeArea}><View style={styles.content}>
    <Text style={styles.eyebrow}>KA IIBI · MARKETPLACE</Text>
    <Text style={styles.title}>Shops are open.</Text>
    <Text style={styles.text}>Browse the shops trading on Ka Iibi, see what they have in today, and order straight from them. You pay the shop when you collect.</Text>
    <Pressable
      testID="marketplace-browse-shops"
      accessibilityRole="link"
      onPress={() => router.push('/store')}
      style={styles.primaryButton}
    >
      <Text style={styles.primaryText}>Browse shops</Text>
    </Pressable>
    <Pressable onPress={() => signOut().then(() => router.replace('/login'))} style={styles.logoutButton}>
      <Text style={styles.logoutText}>Log out</Text>
    </Pressable>
  </View></SafeAreaView>;
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#FFFFFF' },
  content: { flex: 1, width: '100%', maxWidth: 480, alignSelf: 'center', padding: 22, justifyContent: 'center' },
  eyebrow: { color: '#999999', letterSpacing: 1.3, fontSize: 10, fontWeight: '800' },
  title: { color: '#111111', fontSize: 30, letterSpacing: -1.3, fontWeight: '800', marginTop: 8, marginBottom: 12 },
  text: { color: '#666666', fontSize: 14, lineHeight: 21 },
  primaryButton: {
    height: 45, borderRadius: 9, backgroundColor: '#111111',
    alignItems: 'center', justifyContent: 'center', marginTop: 24,
  },
  primaryText: { color: '#FFFFFF', fontSize: 14, fontWeight: '800' },
  logoutButton: { height: 45, borderRadius: 9, borderWidth: 1.5, borderColor: '#111111', alignItems: 'center', justifyContent: 'center', marginTop: 12 },
  logoutText: { color: '#111111', fontSize: 14, fontWeight: '800' },
});
