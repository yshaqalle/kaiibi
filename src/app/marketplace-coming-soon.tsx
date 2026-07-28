import { useRouter } from 'expo-router';
import { Pressable, SafeAreaView, StyleSheet, Text, View } from 'react-native';

import { signOut } from '@/lib/auth';

export default function MarketplaceComingSoonScreen() {
  const router = useRouter();
  return <SafeAreaView style={styles.safeArea}><View style={styles.content}>
    <Text style={styles.eyebrow}>KA IIBI · MARKETPLACE</Text>
    <Text style={styles.title}>Coming soon.</Text>
    <Text style={styles.text}>The Ka Iibi marketplace for shoppers isn&apos;t ready yet — we&apos;re building it. Check back soon.</Text>
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
  logoutButton: { height: 45, borderRadius: 9, borderWidth: 1.5, borderColor: '#111111', alignItems: 'center', justifyContent: 'center', marginTop: 24 },
  logoutText: { color: '#111111', fontSize: 14, fontWeight: '800' },
});
