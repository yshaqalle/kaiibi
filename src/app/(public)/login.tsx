import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, SafeAreaView, StyleSheet, Text, TextInput, View } from 'react-native';

import { signIn } from '@/lib/auth';

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
    <Text style={styles.eyebrow}>KA IIBI · HARGEISA</Text>
    <Text style={styles.title}>Welcome back.</Text>
    <View style={styles.form}>
      <Text style={styles.fieldLabel}>EMAIL</Text>
      <TextInput value={email} onChangeText={setEmail} placeholder="you@example.com" placeholderTextColor="#89928B" autoCapitalize="none" keyboardType="email-address" style={styles.input}/>
      <Text style={styles.fieldLabel}>PASSWORD</Text>
      <TextInput value={password} onChangeText={setPassword} placeholder="Your password" placeholderTextColor="#89928B" secureTextEntry style={styles.input}/>
      {error && <Text style={styles.error}>{error}</Text>}
      <Pressable onPress={submit} style={[styles.submit, submitting && styles.submitDisabled]} disabled={submitting}><Text style={styles.submitText}>{submitting ? 'Logging in…' : 'Log in'}</Text></Pressable>
    </View>
  </View></SafeAreaView>;
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#FAF9F5' },
  content: { flex: 1, width: '100%', maxWidth: 480, alignSelf: 'center', padding: 22, justifyContent: 'center' },
  eyebrow: { color: '#E45B37', letterSpacing: 1.3, fontSize: 10, fontWeight: '800' },
  title: { color: '#17261F', fontSize: 30, letterSpacing: -1.3, fontWeight: '800', marginTop: 8, marginBottom: 24 },
  form: { backgroundColor: '#EEF2EB', borderRadius: 17, padding: 17 },
  fieldLabel: { color: '#657269', letterSpacing: 1, fontSize: 10, fontWeight: '800', marginBottom: 7 },
  input: { backgroundColor: '#FFFFFF', height: 45, borderRadius: 9, paddingHorizontal: 12, color: '#17261F', marginBottom: 13 },
  error: { color: '#C0392B', fontSize: 12, fontWeight: '700', marginBottom: 10 },
  submit: { height: 45, backgroundColor: '#E45B37', borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
  submitDisabled: { backgroundColor: '#C8CCC6' },
  submitText: { color: '#FFFFFF', fontSize: 14, fontWeight: '800' },
});
