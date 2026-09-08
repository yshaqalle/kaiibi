import { useRouter } from 'expo-router';
import { forwardRef, useEffect, useRef, useState } from 'react';
import { Keyboard, KeyboardAvoidingView, Pressable, SafeAreaView, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { useAuth } from '@/hooks/use-auth';
import { useSingleFlight } from '@/hooks/use-single-flight';
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
  const scrollRef = useRef<ScrollView>(null);
  const scrollOffset = useRef(0);
  // Enter walks the fields of a step and, on the last one, presses the button
  // under them. Only the fields something FOCUSES need a ref; the last field of
  // each step submits instead, and needs none.
  const contactRef = useRef<TextInput>(null);
  const emailRef = useRef<TextInput>(null);
  const passwordRef = useRef<TextInput>(null);
  const areaRef = useRef<TextInput>(null);

  // Landscape tablets lose half their height to the keyboard, and with SDK 57
  // edge-to-edge the window never resizes on its own — without this the field
  // being typed into can sit behind the keyboard. Unlike login, this form is
  // taller than the space the keyboard leaves, so scroll only far enough to
  // reveal the focused field rather than jumping to the end of the page.
  useEffect(() => {
    const sub = Keyboard.addListener('keyboardDidShow', (event) => {
      // Wait a beat so KeyboardAvoidingView has resized the ScrollView first.
      setTimeout(() => {
        const input = TextInput.State.currentlyFocusedInput();
        if (!input) return;
        input.measureInWindow((_x, y, _width, height) => {
          const keyboardTop = event.endCoordinates.screenY;
          const overlap = y + height - keyboardTop + 24;
          if (overlap > 0) {
            scrollRef.current?.scrollTo({ y: scrollOffset.current + overlap, animated: true });
          }
        });
      }, 150);
    });
    return () => sub.remove();
  }, []);

  const valid =
    step === 1
      ? Boolean(name.trim() && contact.trim() && email.trim() && password.length >= 6)
      : step === 2
        ? Boolean(shopName.trim())
        : true;

  // `useSingleFlight` because `submitting` alone cannot refuse a second Enter:
  // it is state, and a held return key repeats faster than React re-renders, so
  // both calls read the same stale `false` and two accounts get created. See
  // use-single-flight.ts.
  const createAccount = useSingleFlight(async () => {
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
  });

  const next = () => {
    // Enter reaches this as well as the button, and the return key is never
    // disabled -- so the button's own rule has to be enforced here too, or a
    // half-filled step advances.
    if (!valid || submitting) return;
    // Advancing a step needs no latch: it is synchronous, the screen changes
    // under the finger immediately, and the step it lands on has its own
    // emptiness to refuse a second press with.
    if (step !== totalSteps) {
      setStep((value) => value + 1);
      return;
    }
    void createAccount();
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      {/* "padding" on Android too: with SDK 57 edge-to-edge the window never
          resizes for the IME, so an unset behavior leaves inputs covered. */}
      <KeyboardAvoidingView style={styles.flex} behavior="padding">
        <ScrollView
          ref={scrollRef}
          contentContainerStyle={styles.content}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          onScroll={(e) => {
            scrollOffset.current = e.nativeEvent.contentOffset.y;
          }}
          scrollEventThrottle={16}
        >
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
              <Field
                label={t('signup.yourName')}
                value={name}
                onChangeText={setName}
                placeholder={t('signup.yourNamePlaceholder')}
                onSubmitEditing={() => contactRef.current?.focus()}
              />
              <Field
                ref={contactRef}
                label={t('signup.phone')}
                value={contact}
                onChangeText={setContact}
                placeholder={t('signup.phonePlaceholder')}
                keyboardType="phone-pad"
                onSubmitEditing={() => emailRef.current?.focus()}
              />
              <Field
                ref={emailRef}
                label={t('signup.email')}
                value={email}
                onChangeText={setEmail}
                placeholder={t('signup.emailPlaceholder')}
                keyboardType="email-address"
                autoCapitalize="none"
                onSubmitEditing={() => passwordRef.current?.focus()}
              />
              <Field
                ref={passwordRef}
                label={t('signup.password')}
                value={password}
                onChangeText={setPassword}
                placeholder={t('signup.passwordPlaceholder')}
                secureTextEntry
                onSubmitEditing={next}
                last
              />
            </>
          )}

          {step === 2 && (
            <>
              <Text style={styles.formHeading}>{t('signup.step2')}</Text>
              <Field
                label={t('signup.shopName')}
                value={shopName}
                onChangeText={setShopName}
                placeholder={t('signup.shopNamePlaceholder')}
                onSubmitEditing={next}
                last
              />
            </>
          )}

          {step === 3 && (
            <>
              <Text style={styles.formHeading}>{t('signup.step3')}</Text>
              <Field
                label={t('signup.city')}
                value={location}
                onChangeText={setLocation}
                placeholder={t('signup.cityPlaceholder')}
                onSubmitEditing={() => areaRef.current?.focus()}
              />
              <Field
                ref={areaRef}
                label={t('signup.neighborhood')}
                value={area}
                onChangeText={setArea}
                placeholder={t('signup.neighborhoodPlaceholder')}
                onSubmitEditing={next}
                last
              />
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
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

// Extracted so the three steps read as a list of fields rather than a wall of
// repeated label + TextInput pairs — the labels are now translated, which made
// each one three lines instead of one.
//
// `forwardRef` so a field can hand focus to the one under it: the ref goes to
// the TextInput inside, which is the thing that can take focus.
//
// `last` marks the field Enter SUBMITS from rather than moves on from, and it
// drives both halves of that difference — the return key's label, and whether
// the keyboard stays up. A field in the middle of a step keeps it up
// (`submitBehavior="submit"`), because the next thing that happens is typing
// into the field below; the last one lets it fall, because the next thing is a
// screen change.
const Field = forwardRef<TextInput, {
  label: string;
  value: string;
  onChangeText: (text: string) => void;
  placeholder: string;
  keyboardType?: 'phone-pad' | 'email-address';
  autoCapitalize?: 'none';
  secureTextEntry?: boolean;
  onSubmitEditing?: () => void;
  last?: boolean;
}>(function Field({
  label,
  value,
  onChangeText,
  placeholder,
  keyboardType,
  autoCapitalize,
  secureTextEntry,
  onSubmitEditing,
  last,
}, ref) {
  return (
    <>
      <Text style={styles.fieldLabel}>{label.toUpperCase()}</Text>
      <TextInput
        ref={ref}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor="#999999"
        keyboardType={keyboardType}
        autoCapitalize={autoCapitalize}
        secureTextEntry={secureTextEntry}
        onSubmitEditing={onSubmitEditing}
        returnKeyType={last ? 'go' : 'next'}
        submitBehavior={last ? 'blurAndSubmit' : 'submit'}
        style={styles.input}
      />
    </>
  );
});

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#FFFFFF' },
  flex: { flex: 1 },
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
