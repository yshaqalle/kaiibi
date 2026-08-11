import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Keyboard, KeyboardAvoidingView, Pressable, SafeAreaView, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { KaiibiMark } from '@/components/landing/landing-ui';
import { LanguageSwitch } from '@/components/landing/language-switch';
import { Marketing, MarketingRadius } from '@/constants/marketing-theme';
import { useLocale } from '@/hooks/use-locale';
import { signIn } from '@/lib/auth';

// On native this screen IS the landing page: `(tabs)/index.tsx` redirects `/`
// to here, and the hero band below is what replaced the marketing pitch that
// page used to carry.
//
// So the hero shares its copy with the web hero — the same message keys, not a
// second set that would drift — and carries its own LanguageSwitch. Without
// that switch a native visitor has no way to change language at all: the web
// switchers live in the nav and the footer, and `/about` is the only native
// screen that renders a footer.
//
// The form below is deliberately unchanged apart from its strings.

export default function LoginScreen() {
  const router = useRouter();
  const { t } = useLocale();
  // Where to go after signing in. Set by a guard that bounced you here — the
  // platform portal does, since without it `/platform` sends you to login and
  // login sends you to `/dashboard`, and you never arrive at the thing you
  // asked for.
  //
  // Only ever an in-app path: anything not starting with a single `/` is
  // discarded, so a crafted `?next=//evil.example` cannot turn our login screen
  // into an open redirect.
  const { next } = useLocalSearchParams<{ next?: string }>();
  const destination = typeof next === 'string' && /^\/(?!\/)/.test(next) ? next : '/dashboard';
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<ScrollView>(null);

  // The form is the last thing on the page, so when the keyboard opens —
  // landscape tablets lose half their height to it — scrolling to the end is
  // exactly "bring the inputs above the keyboard". Without this the ScrollView
  // stays at the top showing only the hero, and typing is invisible.
  useEffect(() => {
    const sub = Keyboard.addListener('keyboardDidShow', () => {
      // KeyboardAvoidingView reacts to this same event; wait a beat so the
      // ScrollView has its post-keyboard size before we scroll, otherwise the
      // content still fits and scrollToEnd is a no-op.
      setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 150);
    });
    return () => sub.remove();
  }, []);

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      await signIn({ email: email.trim(), password });
      router.replace(destination as never);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('login.error'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      {/* Landscape tablets: the keyboard covers half the screen and this layout
          is taller than the other half, so without keyboard avoidance the
          focused input hides behind it with no way to scroll it into view. */}
      {/* "padding" on Android too: with SDK 57 edge-to-edge the window never
          resizes for the IME, so an unset behavior leaves inputs covered. */}
      <KeyboardAvoidingView style={styles.flex} behavior="padding">
        <ScrollView
          ref={scrollRef}
          contentContainerStyle={styles.content}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
        <View style={styles.hero}>
          {/* A soft brand wash rather than the old photo watermark, so the
              headline keeps its contrast at any size. */}
          <View style={styles.heroGlow} />

          <View style={styles.heroTop}>
            <View style={styles.brand}>
              <View style={styles.brandTile}>
                <KaiibiMark size={17} />
              </View>
              <Text style={styles.brandText}>Kaiibi</Text>
            </View>
            <LanguageSwitch tone="onDark" compact />
          </View>

          <View style={styles.eyebrow}>
            <View style={styles.eyebrowDot} />
            <Text style={styles.eyebrowText}>{t('hero.eyebrow')}</Text>
          </View>

          <Text style={styles.heroTitle}>
            {t('hero.title1')} <Text style={styles.heroTitleHighlight}>{t('hero.title2')}</Text>{' '}
            {t('hero.title3')}
          </Text>
          <Text style={styles.heroLede}>{t('hero.ledeShort')}</Text>

          <View style={styles.heroNotes}>
            <View style={styles.heroNote}>
              <Text style={styles.heroTick}>✓</Text>
              <Text style={styles.heroNoteText}>{t('hero.note1')}</Text>
            </View>
            <View style={styles.heroNote}>
              <Text style={styles.heroTick}>✓</Text>
              <Text style={styles.heroNoteText}>{t('hero.note2')}</Text>
            </View>
          </View>

          <View style={styles.heroLinks}>
            <Pressable
              onPress={() => router.push('/signup')}
              accessibilityRole="link"
              style={({ pressed }) => [styles.heroLink, styles.heroLinkPrimary, pressed && styles.pressed]}
            >
              <Text style={styles.heroLinkPrimaryText}>{t('login.createShop')}</Text>
            </Pressable>
            <Pressable
              onPress={() => router.push('/about')}
              accessibilityRole="link"
              style={({ pressed }) => [styles.heroLink, styles.heroLinkGhost, pressed && styles.pressed]}
            >
              <Text style={styles.heroLinkGhostText}>{t('login.howItWorks')}</Text>
            </Pressable>
          </View>
        </View>

        <Text style={styles.eyebrowDark}>{t('login.welcomeBack').toUpperCase()}</Text>

        <View style={styles.form}>
          <Text style={styles.fieldLabel}>{t('login.email').toUpperCase()}</Text>
          <TextInput
            value={email}
            onChangeText={setEmail}
            placeholder={t('login.emailPlaceholder')}
            placeholderTextColor="#999999"
            autoCapitalize="none"
            keyboardType="email-address"
            style={styles.input}
          />
          <Text style={styles.fieldLabel}>{t('login.password').toUpperCase()}</Text>
          <TextInput
            value={password}
            onChangeText={setPassword}
            placeholder={t('login.passwordPlaceholder')}
            placeholderTextColor="#999999"
            secureTextEntry
            style={styles.input}
          />
          {error && <Text style={styles.error}>{error}</Text>}
          <Pressable
            onPress={submit}
            style={[styles.submit, submitting && styles.submitDisabled]}
            disabled={submitting}
          >
            <Text style={styles.submitText}>{submitting ? t('login.submitting') : t('login.submit')}</Text>
          </Pressable>
        </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: Marketing.white },
  flex: { flex: 1 },
  content: { flexGrow: 1, width: '100%', maxWidth: 480, alignSelf: 'center', padding: 22, justifyContent: 'center' },

  hero: {
    position: 'relative',
    overflow: 'hidden',
    backgroundColor: Marketing.ink,
    borderRadius: 22,
    padding: 22,
    marginBottom: 20,
  },
  heroGlow: {
    position: 'absolute',
    top: -70,
    right: -60,
    width: 210,
    height: 210,
    borderRadius: 105,
    backgroundColor: 'rgba(15,157,88,0.22)',
  },
  heroTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 16 },
  brand: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  brandTile: {
    width: 28,
    height: 28,
    borderRadius: 8,
    backgroundColor: 'rgba(255,255,255,0.13)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  brandText: { color: Marketing.white, fontSize: 16, fontWeight: '800', letterSpacing: -0.4 },

  eyebrow: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: 'rgba(255,255,255,0.1)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.16)',
    borderRadius: MarketingRadius.pill,
    paddingVertical: 5,
    paddingHorizontal: 11,
  },
  eyebrowDot: { width: 5, height: 5, borderRadius: 3, backgroundColor: Marketing.brand },
  eyebrowText: { fontSize: 10.5, fontWeight: '700', color: 'rgba(255,255,255,0.82)' },

  heroTitle: {
    color: Marketing.white,
    fontSize: 29,
    lineHeight: 32,
    letterSpacing: -1.1,
    fontWeight: '800',
    marginTop: 12,
  },
  heroTitleHighlight: { color: Marketing.white, borderBottomWidth: 7, borderBottomColor: 'rgba(15,157,88,0.55)' },
  heroLede: { color: 'rgba(255,255,255,0.62)', fontSize: 13, lineHeight: 20, marginTop: 10 },

  heroNotes: { flexDirection: 'row', flexWrap: 'wrap', gap: 12, marginTop: 14 },
  heroNote: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  heroTick: { color: Marketing.brand, fontWeight: '800', fontSize: 11.5 },
  heroNoteText: { color: 'rgba(255,255,255,0.72)', fontSize: 11.5, fontWeight: '600' },

  heroLinks: { flexDirection: 'row', gap: 8, marginTop: 16 },
  heroLink: { flex: 1, borderRadius: MarketingRadius.pill, paddingVertical: 11, paddingHorizontal: 8, alignItems: 'center' },
  heroLinkPrimary: { backgroundColor: Marketing.white },
  heroLinkPrimaryText: { color: Marketing.ink, fontSize: 12.5, fontWeight: '700' },
  heroLinkGhost: { backgroundColor: 'rgba(255,255,255,0.1)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.2)' },
  heroLinkGhostText: { color: Marketing.white, fontSize: 12.5, fontWeight: '700' },
  pressed: { opacity: 0.78 },

  eyebrowDark: { color: '#999999', letterSpacing: 1.3, fontSize: 10, fontWeight: '800' },
  form: { backgroundColor: '#F2F2F2', borderRadius: 17, padding: 17, marginTop: 12 },
  fieldLabel: { color: '#999999', letterSpacing: 1, fontSize: 10, fontWeight: '800', marginBottom: 7 },
  input: { backgroundColor: '#FFFFFF', height: 45, borderRadius: 9, paddingHorizontal: 12, color: '#111111', marginBottom: 13 },
  error: { color: '#C0392B', fontSize: 12, fontWeight: '700', marginBottom: 10 },
  submit: { height: 45, backgroundColor: '#111111', borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
  submitDisabled: { backgroundColor: '#CCCCCC' },
  submitText: { color: '#FFFFFF', fontSize: 14, fontWeight: '800' },
});
