import { Redirect, Stack } from 'expo-router';
import { useEffect } from 'react';
import { ActivityIndicator, View } from 'react-native';

import { useAuth } from '@/hooks/use-auth';
import { signOut } from '@/lib/auth';

// Native only — web's (public) layout lives in `_layout.web.tsx` and is
// unaffected by anything below. On native, `(public)` is now gated: an
// authenticated admin/staff session skips straight to the dashboard, an
// authenticated customer session goes to the marketplace stub, and
// everyone else lands on `login`. `login` is reached at cold launch via
// see `(tabs)/index.tsx`'s redirect stub — NOT via a Stack `initialRouteName`,
// which does not affect Expo Router's URL-to-file resolution. `(tabs)`
// (how-it-works/signup) is still reachable as a pushed screen — see
// `app-tabs.tsx` for how native reaches `(tabs)`'s children without a tab
// bar. `marketplace-coming-soon` lives at the app root (sibling of this
// group, see `src/app/_layout.tsx`), not inside `(public)`, so navigating
// there doesn't re-mount this gate and loop back on itself.
export default function PublicLayout() {
  const { loading, session, profile } = useAuth();

  // Safety net for a session with no resolvable profile (e.g. the
  // `profiles` row fetch failed or returned nothing): it matches neither
  // branch below, so it would otherwise fall through to the login-first
  // Stack while still holding an active session — a dead end with no way
  // to sign out and retry, since a fresh login just loops back through
  // `/dashboard` -> `(admin)/_layout.tsx`'s own redirect -> back here. This
  // fire-and-forget sign-out clears that inconsistent state; once it
  // resolves, AuthProvider's own state update naturally re-renders this
  // component into the normal "no session -> login" branch. No-op whenever
  // profile actually resolves.
  useEffect(() => {
    if (session && !loading && !profile) {
      signOut();
    }
  }, [session, loading, profile]);

  if (loading) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator />
      </View>
    );
  }

  if (session && (profile?.role === 'admin' || profile?.role === 'staff')) {
    return <Redirect href="/dashboard" />;
  }

  if (session && profile?.role === 'customer') {
    return <Redirect href="/marketplace-coming-soon" />;
  }

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="login" />
      <Stack.Screen name="(tabs)" />
    </Stack>
  );
}
