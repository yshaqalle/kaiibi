import { Redirect, Stack } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { useAuth } from '@/hooks/use-auth';
import { signOut } from '@/lib/auth';
import { getPlatformAccess } from '@/lib/platform';
import { supabase } from '@/lib/supabase';

// Kaiibi's back office. Everything here is about OUR customers, not one shop's
// data, so the front door is deliberately stricter than the rest of the app.
//
// This gate is UI only. The real boundary is is_platform_admin() in the
// database (migration 20260818000500), which requires an aal2 token on every
// single read and which the platform-admin edge function re-checks before every
// write. A user who bypassed this screen entirely would still see nothing and
// be able to change nothing.
export default function PlatformLayout() {
  const { loading, session } = useAuth();
  // Tagged with the user it was resolved FOR, and read back through that tag.
  // Without it, an operator signing out and someone else signing in would leave
  // the previous verdict in state until the new fetch resolved — a brief window
  // where the wrong person sees the portal shell. Keying it makes a stale
  // verdict unreadable by construction rather than by timing.
  const userId = session?.user.id ?? null;
  const [access, setAccess] = useState<{ userId: string; isAdmin: boolean; pendingMfa: boolean } | null>(null);
  const resolved = access && access.userId === userId ? access : null;

  useEffect(() => {
    if (!userId) return;
    let active = true;
    getPlatformAccess()
      .then((next) => {
        if (active) setAccess({ userId, ...next });
      })
      // Fails closed: an unresolved answer is treated as "not an operator".
      .catch(() => {
        if (active) setAccess({ userId, isAdmin: false, pendingMfa: false });
      });
    return () => {
      active = false;
    };
  }, [userId]);

  // Web only. Not a security control -- the database is -- but the portal is a
  // desk tool with dense tables, and shipping it into the phone app would put
  // an attack surface on every device that only three people ever use.
  if (Platform.OS !== 'web') return <Redirect href="/" />;

  if (loading || (session && !resolved)) {
    return (
      <View style={styles.centre}>
        <ActivityIndicator />
      </View>
    );
  }

  // Carries the destination, because login's own default is `/dashboard` — the
  // shop app. Without this an operator opening /platform signed out is bounced
  // to login, then landed in a shop, with no sign the portal was ever the
  // target.
  if (!session) return <Redirect href={'/login?next=/platform' as never} />;

  if (resolved?.pendingMfa) return <MfaChallenge />;

  // Says nothing about whether the account exists or is an operator. Somebody
  // who lands here by guessing the URL learns only that they can't come in.
  if (!resolved?.isAdmin) {
    return (
      <View style={styles.centre}>
        <Text style={styles.title}>Not available</Text>
        <Text style={styles.body}>This account doesn&apos;t have access to this page.</Text>
        <Pressable onPress={() => signOut()}>
          <Text style={styles.link}>Sign out</Text>
        </Pressable>
      </View>
    );
  }

  return <Stack screenOptions={{ headerShown: false }} />;
}

// The second factor. An operator who has never enrolled is walked through
// enrolment here rather than being turned away: they are staff, and a support
// person locked out by their own security control is a support person who will
// ask for it to be turned off.
function MfaChallenge() {
  const [code, setCode] = useState('');
  const [factorId, setFactorId] = useState<string | null>(null);
  const [enrolUri, setEnrolUri] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    (async () => {
      const { data, error: listError } = await supabase.auth.mfa.listFactors();
      if (!active) return;
      if (listError) {
        setError(listError.message);
        return;
      }
      const verified = data.totp?.find((f) => f.status === 'verified');
      if (verified) {
        setFactorId(verified.id);
        return;
      }
      // No factor yet — start enrolment and show the secret to type into an
      // authenticator app.
      const { data: enrolled, error: enrolError } = await supabase.auth.mfa.enroll({ factorType: 'totp' });
      if (!active) return;
      if (enrolError) {
        setError(enrolError.message);
        return;
      }
      setFactorId(enrolled.id);
      setEnrolUri(enrolled.totp.uri);
      setSecret(enrolled.totp.secret);
    })();
    return () => {
      active = false;
    };
  }, []);

  const verify = async () => {
    if (!factorId || code.trim().length < 6) return;
    setBusy(true);
    setError(null);
    try {
      const { data: challenge, error: challengeError } = await supabase.auth.mfa.challenge({ factorId });
      if (challengeError) throw challengeError;
      const { error: verifyError } = await supabase.auth.mfa.verify({
        factorId,
        challengeId: challenge.id,
        code: code.trim(),
      });
      if (verifyError) throw verifyError;
      // Verifying swaps the session for an aal2 one; onAuthStateChange in
      // use-auth picks it up, which re-runs the access check in the layout.
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That code was not accepted.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.centre}>
      <Text style={styles.brand}>KAIIBI · PLATFORM</Text>
      <Text style={styles.title}>Two-factor code required</Text>

      {secret && (
        <View style={styles.enrolBox}>
          <Text style={styles.body}>
            Add this secret to your authenticator app, then enter the code it shows.
          </Text>
          <Text selectable style={styles.secret}>
            {secret}
          </Text>
          {enrolUri ? (
            <Text selectable style={styles.uri} numberOfLines={2}>
              {enrolUri}
            </Text>
          ) : null}
        </View>
      )}

      <TextInput
        value={code}
        onChangeText={setCode}
        placeholder="000000"
        placeholderTextColor="#BBBBBB"
        keyboardType="number-pad"
        maxLength={6}
        style={styles.codeInput}
      />
      {error && <Text style={styles.error}>{error}</Text>}
      <Pressable onPress={verify} disabled={busy || code.trim().length < 6} style={[styles.button, (busy || code.trim().length < 6) && styles.buttonDisabled]}>
        <Text style={styles.buttonText}>{busy ? 'Checking…' : 'Verify'}</Text>
      </Pressable>
      <Pressable onPress={() => signOut()}>
        <Text style={styles.link}>Sign out</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  centre: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 10, backgroundColor: '#FFFFFF' },
  brand: { color: '#777777', fontSize: 11, fontWeight: '800', letterSpacing: 1.5, marginBottom: 6 },
  title: { color: '#111111', fontSize: 18, fontWeight: '800' },
  body: { color: '#777777', fontSize: 13, textAlign: 'center', maxWidth: 380, lineHeight: 19 },
  enrolBox: { alignItems: 'center', gap: 8, marginVertical: 8, maxWidth: 420 },
  secret: { color: '#111111', fontSize: 15, fontWeight: '800', letterSpacing: 2, fontFamily: Platform.OS === 'web' ? 'monospace' : undefined },
  uri: { color: '#AAAAAA', fontSize: 10, textAlign: 'center' },
  codeInput: {
    borderWidth: 1, borderColor: '#DDDDDD', borderRadius: 10, paddingHorizontal: 16, paddingVertical: 12,
    fontSize: 22, fontWeight: '800', letterSpacing: 8, textAlign: 'center', width: 200, color: '#111111', marginTop: 6,
  },
  button: { backgroundColor: '#111111', borderRadius: 10, paddingHorizontal: 24, paddingVertical: 12, marginTop: 4 },
  buttonDisabled: { backgroundColor: '#DDDDDD' },
  buttonText: { color: '#FFFFFF', fontSize: 12, fontWeight: '800' },
  link: { color: '#777777', fontSize: 12, fontWeight: '700', marginTop: 10 },
  error: { color: '#C0392B', fontSize: 12, fontWeight: '700' },
});
