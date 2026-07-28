import { Redirect, Stack } from 'expo-router';
import { ActivityIndicator, View } from 'react-native';

import { useAuth } from '@/hooks/use-auth';

// Native only — web's (public) layout lives in `_layout.web.tsx` and is
// unaffected by anything below. On native, `(public)` is now gated: an
// authenticated admin/staff session skips straight to the dashboard, an
// authenticated customer session goes to the marketplace stub, and
// everyone else lands on `login`. `login` is reached at cold launch via
// `(tabs)/index.tsx`'s native redirect stub (Step 2 below) — NOT via a
// Stack `initialRouteName`, which does not affect Expo Router's URL-to-file
// resolution. `(tabs)` (how-it-works/signup) and the new
// `marketplace-coming-soon` screen are still reachable as pushed screens —
// see `app-tabs.tsx` for how native reaches `(tabs)`'s children without a
// tab bar.
export default function PublicLayout() {
  const { loading, session, profile } = useAuth();

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
      <Stack.Screen name="marketplace-coming-soon" options={{ headerShown: true, title: '', headerBackButtonDisplayMode: 'minimal' }} />
    </Stack>
  );
}
