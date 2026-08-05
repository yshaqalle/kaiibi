import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, SafeAreaView, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { useAuth } from '@/hooks/use-auth';
import { useLocale } from '@/hooks/use-locale';
import { signUpAdmin } from '@/lib/auth';
import { createShop } from '@/lib/shops';

const totalSteps = 3;

export default function SignUpScreen() {
  const router = useRouter();
  const { t } = useLocale();
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
      await signUpAdmin({ email: email.trim(), password, fullName: name.trim(), phone: contact.trim() });
      await createShop({ name: shopName.trim(), city: location.trim() || 'Hargeisa', neighborhood: area.trim() || undefined });
      await refreshShop();
      router.replace('/dashboard');
    } catch (err) {
      setError(err instanceof Error ? err.message : t('signup.error'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <Text style={styles.eyebrow}>{t('signup.eyebrow').toUpperCase()}</Text>
        <Text style={styles.title}>{t('signup.title')}</Text>
        <Text style={styles.subtitle}>{t('signup.lede')}</Text>

        <View style={styles.form}>
          <View style={styles.progressRow}>
            <Text style={styles.progress}>
              {t('signup.progress', { step, total: totalSteps }).toUpperCase()}
            </Text>
            {step > 1 && (
              <Pressable onPress={() => setStep((value) => value - 1)}>
                <Text style={styles.back}>{t('signup.back')}</Text>
              </Pressable>
            )}
          </View>

          <View style={styles.stepDots}>
            {Array.from({ length: totalSteps }, (_, index) => (
              <View key={index} style={[styles.stepDot, index < step && styles.stepDotActive]} />
            ))}
          </View>

          {step === 1 && (
            <>
              <Text style={styles.formHeading}>{t('signup.step1')}</Text>
              <Field label={t('signup.yourName')} value={name} onChangeText={setName} placeholder={t('signup.yourNamePlaceholder')} />
              <Field
                label={t('signup.phone')}
                value={contact}
                onChangeText={setContact}
                placeholder={t('signup.phonePlaceholder')}
                keyboardType="phone-pad"
              />
              <Field
                label={t('signup.email')}
                value={email}
                onChangeText={setEmail}
                placeholder={t('signup.emailPlaceholder')}
                keyboardType="email-address"
                autoCapitalize="none"
              />
              <Field
                label={t('signup.password')}
                value={password}
                onChangeText={setPassword}
                placeholder={t('signup.passwordPlaceholder')}
                secureTextEntry
              />
            </>
          )}

          {step === 2 && (
            <>
              <Text style={styles.formHeading}>{t('signup.step2')}</Text>
              <Field label={t('signup.shopName')} value={shopName} onChangeText={setShopName} placeholder={t('signup.shopNamePlaceholder')} />
            </>
          )}

          {step === 3 && (
            <>
              <Text style={styles.formHeading}>{t('signup.step3')}</Text>
              <Field label={t('signup.city')} value={location} onChangeText={setLocation} placeholder={t('signup.cityPlaceholder')} />
              <Field label={t('signup.neighborhood')} value={area} onChangeText={setArea} placeholder={t('signup.neighborhoodPlaceholder')} />
            </>
          )}

          {error && <Text style={styles.error}>{error}</Text>}

          <Pressable
            onPress={next}
            style={[styles.submit, (!valid || submitting) && styles.submitDisabled]}
            disabled={!valid || submitting}
          >
            <Text style={styles.submitText}>
              {submitting ? t('signup.creating') : step === totalSteps ? t('signup.create') : t('common.continue')}
            </Text>
          </Pressable>

          <Pressable onPress={() => router.push('/login')}>
            <Text style={styles.loginLink}>{t('signup.haveShop')}</Text>
          </Pressable>
        </View>

        <Text style={styles.terms}>
          {t('signup.termsBefore')}{' '}
          <Text style={styles.termsLink} onPress={() => router.push('/privacy/policy')}>
            {t('signup.privacy')}
          </Text>
          .
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

// Extracted so the three steps read as a list of fields rather than a wall of
// repeated label + TextInput pairs — the labels are now translated, which made
// each one three lines instead of one.
function Field({
  label,
  value,
  onChangeText,
  placeholder,
  keyboardType,
  autoCapitalize,
  secureTextEntry,
}: {
  label: string;
  value: string;
  onChangeText: (text: string) => void;
  placeholder: string;
  keyboardType?: 'phone-pad' | 'email-address';
  autoCapitalize?: 'none';
  secureTextEntry?: boolean;
}) {
  return (
    <>
      <Text style={styles.fieldLabel}>{label.toUpperCase()}</Text>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor="#999999"
        keyboardType={keyboardType}
        autoCapitalize={autoCapitalize}
        secureTextEntry={secureTextEntry}
        style={styles.input}
      />
    </>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#FFFFFF' },
  content: { width: '100%', maxWidth: 640, alignSelf: 'center', padding: 22, paddingTop: 38, paddingBottom: 60 },
  eyebrow: { color: '#999999', letterSpacing: 1.3, fontSize: 10, fontWeight: '800' },
  title: { color: '#111111', fontSize: 35, lineHeight: 40, letterSpacing: -1.7, fontWeight: '800', marginTop: 8 },
  subtitle: { color: '#666666', fontSize: 14, lineHeight: 21, marginTop: 10, maxWidth: 430 },
  form: { marginTop: 27, backgroundColor: '#F2F2F2', borderRadius: 17, padding: 17 },
  progressRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  progress: { color: '#999999', fontSize: 10, letterSpacing: 1.1, fontWeight: '800' },
  back: { color: '#111111', fontSize: 12, fontWeight: '800' },
  stepDots: { flexDirection: 'row', gap: 5, marginTop: 13, marginBottom: 20 },
  stepDot: { height: 4, flex: 1, backgroundColor: '#DDDDDD', borderRadius: 3 },
  stepDotActive: { backgroundColor: '#111111' },
  formHeading: { color: '#111111', fontSize: 21, letterSpacing: -0.6, fontWeight: '800', marginBottom: 17 },
  fieldLabel: { color: '#999999', letterSpacing: 1, fontSize: 10, fontWeight: '800', marginBottom: 7 },
  input: { backgroundColor: '#FFFFFF', height: 45, borderRadius: 9, paddingHorizontal: 12, color: '#111111', marginBottom: 13 },
  error: { color: '#C0392B', fontSize: 12, fontWeight: '700', marginBottom: 10 },
  submit: { height: 45, backgroundColor: '#111111', borderRadius: 9, alignItems: 'center', justifyContent: 'center', marginTop: 3 },
  submitDisabled: { backgroundColor: '#CCCCCC' },
  submitText: { color: '#FFFFFF', fontSize: 14, fontWeight: '800' },
  loginLink: { color: '#111111', fontSize: 12, fontWeight: '800', textAlign: 'center', marginTop: 14 },
  terms: { color: '#999999', fontSize: 11, lineHeight: 16, marginTop: 16, textAlign: 'center' },
  termsLink: { color: '#111111', fontWeight: '800', textDecorationLine: 'underline' },
});
