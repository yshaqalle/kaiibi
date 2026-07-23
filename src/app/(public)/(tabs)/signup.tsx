import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, SafeAreaView, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { signUpOwner } from '@/lib/auth';
import { createShop } from '@/lib/shops';
import { useAuth } from '@/hooks/use-auth';

const totalSteps = 3;

export default function SignUpScreen() {
  const router = useRouter();
  const { refreshShop } = useAuth();
  const [step, setStep] = useState(1);
  const [name, setName] = useState('');
  const [contact, setContact] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [shopName, setShopName] = useState('');
  const [location, setLocation] = useState('Hargeisa');
  const [area, setArea] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const valid =
    step === 1
      ? Boolean(name.trim() && contact.trim() && email.trim() && password.length >= 6)
      : step === 2
        ? Boolean(shopName.trim())
        : true;

  const next = async () => {
    if (step !== totalSteps) {
      setStep((value) => value + 1);
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await signUpOwner({ email: email.trim(), password, fullName: name.trim(), phone: contact.trim() });
      await createShop({ name: shopName.trim(), city: location.trim() || 'Hargeisa', neighborhood: area.trim() || undefined });
      await refreshShop();
      router.replace('/dashboard');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  return <SafeAreaView style={styles.safeArea}><ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
    <Text style={styles.eyebrow}>KA IIBI</Text><Text style={styles.title}>Create your shop account.</Text><Text style={styles.subtitle}>We will get your shop ready in a few quick steps.</Text>
    <View style={styles.form}>
      <View style={styles.progressRow}>
        <Text style={styles.progress}>STEP {step} OF {totalSteps}</Text>
        {step > 1 && <Pressable onPress={() => setStep((value) => value - 1)}><Text style={styles.back}>← Back</Text></Pressable>}
      </View>
      <View style={styles.stepDots}>{Array.from({ length: totalSteps }, (_, index) => <View key={index} style={[styles.stepDot, index < step && styles.stepDotActive]} />)}</View>
      {step === 1 && <><Text style={styles.formHeading}>First, your details</Text><Text style={styles.fieldLabel}>YOUR NAME</Text><TextInput value={name} onChangeText={setName} placeholder="Full name" placeholderTextColor="#999999" style={styles.input}/><Text style={styles.fieldLabel}>PHONE OR WHATSAPP</Text><TextInput value={contact} onChangeText={setContact} placeholder="e.g. +252 63 000 0000" placeholderTextColor="#999999" keyboardType="phone-pad" style={styles.input}/><Text style={styles.fieldLabel}>EMAIL</Text><TextInput value={email} onChangeText={setEmail} placeholder="you@example.com" placeholderTextColor="#999999" autoCapitalize="none" keyboardType="email-address" style={styles.input}/><Text style={styles.fieldLabel}>PASSWORD</Text><TextInput value={password} onChangeText={setPassword} placeholder="At least 6 characters" placeholderTextColor="#999999" secureTextEntry style={styles.input}/></>}
      {step === 2 && <><Text style={styles.formHeading}>Tell us about your shop</Text><Text style={styles.fieldLabel}>SHOP NAME</Text><TextInput value={shopName} onChangeText={setShopName} placeholder="Your shop name" placeholderTextColor="#999999" style={styles.input}/></>}
      {step === 3 && <><Text style={styles.formHeading}>Where is your shop?</Text><Text style={styles.fieldLabel}>CITY</Text><TextInput value={location} onChangeText={setLocation} placeholder="Hargeisa" placeholderTextColor="#999999" style={styles.input}/><Text style={styles.fieldLabel}>NEIGHBORHOOD OR LANDMARK</Text><TextInput value={area} onChangeText={setArea} placeholder="e.g. Jigjiga Yar, near the main market" placeholderTextColor="#999999" style={styles.input}/></>}
      {error && <Text style={styles.error}>{error}</Text>}
      <Pressable onPress={next} style={[styles.submit, (!valid || submitting) && styles.submitDisabled]} disabled={!valid || submitting}><Text style={styles.submitText}>{submitting ? 'Creating…' : step === totalSteps ? 'Create account' : 'Continue'}</Text></Pressable>
      <Pressable onPress={() => router.push('/login')}><Text style={styles.loginLink}>Already have a shop? Log in</Text></Pressable>
    </View>
    <Text style={styles.terms}>By continuing, you agree to use Ka Iibi respectfully and keep your information accurate.</Text>
  </ScrollView></SafeAreaView>;
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#FFFFFF' }, content: { width: '100%', maxWidth: 640, alignSelf: 'center', padding: 22, paddingTop: 38, paddingBottom: 60 }, eyebrow: { color: '#999999', letterSpacing: 1.3, fontSize: 10, fontWeight: '800' }, title: { color: '#111111', fontSize: 35, lineHeight: 40, letterSpacing: -1.7, fontWeight: '800', marginTop: 8 }, subtitle: { color: '#666666', fontSize: 14, lineHeight: 21, marginTop: 10, maxWidth: 430 }, form: { marginTop: 27, backgroundColor: '#F2F2F2', borderRadius: 17, padding: 17 }, progressRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }, progress: { color: '#999999', fontSize: 10, letterSpacing: 1.1, fontWeight: '800' }, back: { color: '#111111', fontSize: 12, fontWeight: '800' }, stepDots: { flexDirection: 'row', gap: 5, marginTop: 13, marginBottom: 20 }, stepDot: { height: 4, flex: 1, backgroundColor: '#DDDDDD', borderRadius: 3 }, stepDotActive: { backgroundColor: '#111111' }, formHeading: { color: '#111111', fontSize: 21, letterSpacing: -.6, fontWeight: '800', marginBottom: 17 }, fieldLabel: { color: '#999999', letterSpacing: 1, fontSize: 10, fontWeight: '800', marginBottom: 7 }, input: { backgroundColor: '#FFFFFF', height: 45, borderRadius: 9, paddingHorizontal: 12, color: '#111111', marginBottom: 13 }, error: { color: '#C0392B', fontSize: 12, fontWeight: '700', marginBottom: 10 }, submit: { height: 45, backgroundColor: '#111111', borderRadius: 9, alignItems: 'center', justifyContent: 'center', marginTop: 3 }, submitDisabled: { backgroundColor: '#CCCCCC' }, submitText: { color: '#FFFFFF', fontSize: 14, fontWeight: '800' }, loginLink: { color: '#111111', fontSize: 12, fontWeight: '800', textAlign: 'center', marginTop: 14 }, terms: { color: '#999999', fontSize: 11, lineHeight: 16, marginTop: 16, textAlign: 'center' },
});
