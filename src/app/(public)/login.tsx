import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, SafeAreaView, StyleSheet, Text, TextInput, View } from 'react-native';

import { signIn } from '@/lib/auth';
import { Fonts } from '@/constants/theme';

const kMark = require('@/assets/images/cover.jpeg');

export default function LoginScreen() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      await signIn({ email: email.trim(), password });
      router.replace('/dashboard');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not log in. Check your email and password.');
    } finally {
      setSubmitting(false);
    }
  };

  return <SafeAreaView style={styles.safeArea}><View style={styles.content}>
    <View style={styles.hero}>
      <Image source={kMark} contentFit="contain" style={styles.heroMark} />
      <Text style={styles.heroEyebrow}>SIMPLE POS & INVENTORY</Text>
      <Text style={styles.heroTitle}>Sell fast.{'\n'}Stock smart.</Text>
      <Text style={styles.heroTrust}>No monthly fees · Works on phone or browser</Text>
      <View style={styles.heroLinks}>
        <Pressable onPress={() => router.push('/about')}><Text style={styles.heroLink}>How it works</Text></Pressable>
        <Pressable onPress={() => router.push('/signup')}><Text style={styles.heroLink}>Create a shop</Text></Pressable>
      </View>
    </View>

    <View style={styles.brandRow}>
      <View style={styles.markTile}><Image source={kMark} contentFit="cover" style={styles.markTileImage} /></View>
      <Text style={styles.eyebrow}>WELCOME BACK</Text>
    </View>
    <View style={styles.form}>
      <Text style={styles.fieldLabel}>EMAIL</Text>
      <TextInput value={email} onChangeText={setEmail} placeholder="you@example.com" placeholderTextColor="#999999" autoCapitalize="none" keyboardType="email-address" style={styles.input}/>
      <Text style={styles.fieldLabel}>PASSWORD</Text>
      <TextInput value={password} onChangeText={setPassword} placeholder="Your password" placeholderTextColor="#999999" secureTextEntry style={styles.input}/>
      {error && <Text style={styles.error}>{error}</Text>}
      <Pressable onPress={submit} style={[styles.submit, submitting && styles.submitDisabled]} disabled={submitting}><Text style={styles.submitText}>{submitting ? 'Logging in…' : 'Log in'}</Text></Pressable>
    </View>
  </View></SafeAreaView>;
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#FFFFFF' },
  content: { flex: 1, width: '100%', maxWidth: 480, alignSelf: 'center', padding: 22, justifyContent: 'center' },
  hero: { position: 'relative', overflow: 'hidden', backgroundColor: '#111111', borderRadius: 19, padding: 20, marginBottom: 22 },
  heroMark: { position: 'absolute', top: -30, right: -50, width: 200, height: 200, opacity: 0.18 },
  heroEyebrow: { color: '#999999', letterSpacing: 1.4, fontSize: 9, fontWeight: '800' },
  heroTitle: { fontFamily: Fonts.serif, color: '#FFFFFF', fontSize: 28, lineHeight: 32, letterSpacing: -0.8, fontWeight: '700', marginTop: 8 },
  heroTrust: { color: '#999999', fontSize: 11, fontWeight: '600', marginTop: 10 },
  heroLinks: { flexDirection: 'row', gap: 16, marginTop: 14 },
  heroLink: { color: '#FFFFFF', fontSize: 12, fontWeight: '800', textDecorationLine: 'underline' },
  brandRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  markTile: { width: 26, height: 26, borderRadius: 7, overflow: 'hidden', backgroundColor: '#111111' },
  markTileImage: { width: '100%', height: '100%' },
  eyebrow: { color: '#999999', letterSpacing: 1.3, fontSize: 10, fontWeight: '800' },
  form: { backgroundColor: '#F2F2F2', borderRadius: 17, padding: 17, marginTop: 12 },
  fieldLabel: { color: '#999999', letterSpacing: 1, fontSize: 10, fontWeight: '800', marginBottom: 7 },
  input: { backgroundColor: '#FFFFFF', height: 45, borderRadius: 9, paddingHorizontal: 12, color: '#111111', marginBottom: 13 },
  error: { color: '#C0392B', fontSize: 12, fontWeight: '700', marginBottom: 10 },
  submit: { height: 45, backgroundColor: '#111111', borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
  submitDisabled: { backgroundColor: '#CCCCCC' },
  submitText: { color: '#FFFFFF', fontSize: 14, fontWeight: '800' },
});
