import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, SafeAreaView, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { signUpOwner } from '@/lib/auth';
import { createShop } from '@/lib/shops';
import { useAuth } from '@/hooks/use-auth';

type Role = 'customer' | 'owner' | null;

export default function SignUpScreen() {
  const router = useRouter();
  const { refreshShop } = useAuth();
  const [role, setRole] = useState<Role>(null);
  const [step, setStep] = useState(0);
  const [name, setName] = useState('');
  const [contact, setContact] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [shopName, setShopName] = useState('');
  const [location, setLocation] = useState('Hargeisa');
  const [area, setArea] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [complete, setComplete] = useState(false);
  const totalSteps = role === 'owner' ? 3 : 2;

  const valid =
    step === 1
      ? Boolean(name.trim() && contact.trim() && email.trim() && password.length >= 6)
      : step === 2 && role === 'owner'
        ? Boolean(shopName.trim())
        : true;

  const next = async () => {
    if (step !== totalSteps) {
      setStep((value) => value + 1);
      return;
    }
    if (role !== 'owner') {
      setComplete(true);
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

  if (complete) return <SafeAreaView style={styles.safeArea}><View style={styles.successWrap}><View style={styles.successMark}><Text style={styles.successCheck}>✓</Text></View><Text style={styles.successTitle}>You’re all set.</Text><Text style={styles.successText}>Welcome to Ka Iibi. Start discovering local shops near you.</Text></View></SafeAreaView>;

  return <SafeAreaView style={styles.safeArea}><ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
    <Text style={styles.eyebrow}>KA IIBI</Text><Text style={styles.title}>{role ? 'Create your account.' : 'Join your local marketplace.'}</Text><Text style={styles.subtitle}>{role ? (role === 'owner' ? 'We will get your shop ready in a few quick steps.' : 'A few details and you can start shopping local.') : 'Choose how you want to use Ka Iibi.'}</Text>
    {!role ? <View style={styles.roleChoices}>
      <Pressable onPress={() => { setRole('customer'); setStep(1); }} style={[styles.roleCard, styles.customerCard]}><Text style={styles.roleIcon}>⌕</Text><Text style={styles.roleTitle}>I’m a customer</Text><Text style={styles.roleText}>Discover local shops and find what you need.</Text><Text style={styles.roleAction}>Continue as customer  →</Text></Pressable>
      <Pressable onPress={() => { setRole('owner'); setStep(1); }} style={[styles.roleCard, styles.ownerCard]}><Text style={styles.roleIcon}>▦</Text><Text style={styles.roleTitle}>I own a shop</Text><Text style={styles.roleText}>Create a storefront, manage stock, and reach new customers.</Text><Text style={styles.roleAction}>Continue as shop owner  →</Text></Pressable>
    </View> : <View style={styles.form}>
      <View style={styles.progressRow}><Text style={styles.progress}>STEP {step} OF {totalSteps}</Text><Pressable onPress={() => step === 1 ? (setRole(null), setStep(0)) : setStep((value) => value - 1)}><Text style={styles.back}>← Back</Text></Pressable></View>
      <View style={styles.stepDots}>{Array.from({ length: totalSteps }, (_, index) => <View key={index} style={[styles.stepDot, index < step && styles.stepDotActive]} />)}</View>
      {step === 1 && <><Text style={styles.formHeading}>First, your details</Text><Text style={styles.fieldLabel}>YOUR NAME</Text><TextInput value={name} onChangeText={setName} placeholder="Full name" placeholderTextColor="#89928B" style={styles.input}/><Text style={styles.fieldLabel}>PHONE OR WHATSAPP</Text><TextInput value={contact} onChangeText={setContact} placeholder="e.g. +252 63 000 0000" placeholderTextColor="#89928B" keyboardType="phone-pad" style={styles.input}/><Text style={styles.fieldLabel}>EMAIL</Text><TextInput value={email} onChangeText={setEmail} placeholder="you@example.com" placeholderTextColor="#89928B" autoCapitalize="none" keyboardType="email-address" style={styles.input}/><Text style={styles.fieldLabel}>PASSWORD</Text><TextInput value={password} onChangeText={setPassword} placeholder="At least 6 characters" placeholderTextColor="#89928B" secureTextEntry style={styles.input}/></>}
      {step === 2 && role === 'customer' && <><Text style={styles.formHeading}>Where will you be shopping?</Text><Text style={styles.fieldLabel}>CITY</Text><TextInput value={location} onChangeText={setLocation} placeholder="Hargeisa" placeholderTextColor="#89928B" style={styles.input}/></>}
      {step === 2 && role === 'owner' && <><Text style={styles.formHeading}>Tell us about your shop</Text><Text style={styles.fieldLabel}>SHOP NAME</Text><TextInput value={shopName} onChangeText={setShopName} placeholder="Your shop name" placeholderTextColor="#89928B" style={styles.input}/></>}
      {step === 3 && role === 'owner' && <><Text style={styles.formHeading}>Where is your shop?</Text><Text style={styles.fieldLabel}>CITY</Text><TextInput value={location} onChangeText={setLocation} placeholder="Hargeisa" placeholderTextColor="#89928B" style={styles.input}/><Text style={styles.fieldLabel}>NEIGHBORHOOD OR LANDMARK</Text><TextInput value={area} onChangeText={setArea} placeholder="e.g. Jigjiga Yar, near the main market" placeholderTextColor="#89928B" style={styles.input}/></>}
      {error && <Text style={styles.error}>{error}</Text>}
      <Pressable onPress={next} style={[styles.submit, (!valid || submitting) && styles.submitDisabled]} disabled={!valid || submitting}><Text style={styles.submitText}>{submitting ? 'Creating…' : step === totalSteps ? 'Create account' : 'Continue'}</Text></Pressable>
      <Pressable onPress={() => router.push('/login')}><Text style={styles.loginLink}>Already have a shop? Log in</Text></Pressable>
    </View>}
    <Text style={styles.terms}>By continuing, you agree to use Ka Iibi respectfully and keep your information accurate.</Text>
  </ScrollView></SafeAreaView>;
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#FAF9F5' }, content: { width: '100%', maxWidth: 640, alignSelf: 'center', padding: 22, paddingTop: 38, paddingBottom: 60 }, eyebrow: { color: '#E45B37', letterSpacing: 1.3, fontSize: 10, fontWeight: '800' }, title: { color: '#17261F', fontSize: 35, lineHeight: 40, letterSpacing: -1.7, fontWeight: '800', marginTop: 8 }, subtitle: { color: '#5A665F', fontSize: 14, lineHeight: 21, marginTop: 10, maxWidth: 430 }, roleChoices: { gap: 12, marginTop: 27 }, roleCard: { borderRadius: 17, padding: 21, minHeight: 177 }, customerCard: { backgroundColor: '#DCE8E8' }, ownerCard: { backgroundColor: '#F1E6D6' }, roleIcon: { color: '#17261F', fontSize: 25, fontWeight: '800' }, roleTitle: { color: '#17261F', fontSize: 21, letterSpacing: -.6, fontWeight: '800', marginTop: 8 }, roleText: { color: '#4C5A52', fontSize: 13, lineHeight: 19, marginTop: 6, maxWidth: 350 }, roleAction: { color: '#17261F', fontSize: 13, fontWeight: '800', marginTop: 18 }, form: { marginTop: 27, backgroundColor: '#EEF2EB', borderRadius: 17, padding: 17 }, progressRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }, progress: { color: '#E45B37', fontSize: 10, letterSpacing: 1.1, fontWeight: '800' }, back: { color: '#47705C', fontSize: 12, fontWeight: '800' }, stepDots: { flexDirection: 'row', gap: 5, marginTop: 13, marginBottom: 20 }, stepDot: { height: 4, flex: 1, backgroundColor: '#D2DACE', borderRadius: 3 }, stepDotActive: { backgroundColor: '#E45B37' }, formHeading: { color: '#17261F', fontSize: 21, letterSpacing: -.6, fontWeight: '800', marginBottom: 17 }, fieldLabel: { color: '#657269', letterSpacing: 1, fontSize: 10, fontWeight: '800', marginBottom: 7 }, input: { backgroundColor: '#FFFFFF', height: 45, borderRadius: 9, paddingHorizontal: 12, color: '#17261F', marginBottom: 13 }, error: { color: '#C0392B', fontSize: 12, fontWeight: '700', marginBottom: 10 }, submit: { height: 45, backgroundColor: '#E45B37', borderRadius: 9, alignItems: 'center', justifyContent: 'center', marginTop: 3 }, submitDisabled: { backgroundColor: '#C8CCC6' }, submitText: { color: '#FFFFFF', fontSize: 14, fontWeight: '800' }, loginLink: { color: '#47705C', fontSize: 12, fontWeight: '800', textAlign: 'center', marginTop: 14 }, terms: { color: '#858C85', fontSize: 11, lineHeight: 16, marginTop: 16, textAlign: 'center' }, successWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 34 }, successMark: { width: 54, height: 54, borderRadius: 27, backgroundColor: '#47705C', alignItems: 'center', justifyContent: 'center' }, successCheck: { color: '#FFFFFF', fontSize: 25, fontWeight: '800' }, successTitle: { color: '#17261F', fontSize: 30, letterSpacing: -1.2, fontWeight: '800', marginTop: 18 }, successText: { color: '#5B695F', fontSize: 14, lineHeight: 21, textAlign: 'center', marginTop: 9, maxWidth: 370 },
});
