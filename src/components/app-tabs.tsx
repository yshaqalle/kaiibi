import { Stack, useRouter } from 'expo-router';
import { Pressable, Text } from 'react-native';

// Native only — web's version of this component (`app-tabs.web.tsx`) keeps
// its own top-nav `Tabs`/`TabSlot` implementation, untouched. On native,
// `login` (see `(public)/_layout.tsx`) is the app's home screen; `about`
// and `signup` are pushed screens reached via buttons/links from login or
// from each other. `index` is never actually shown to a user — it's
// `(tabs)/index.tsx`'s redirect-to-`/login` stub, kept headerless so no
// header flashes before the redirect fires.
//
// `about`/`signup` get an explicit `headerLeft` that always replaces to
// `/login`, rather than relying on the native back button's default
// behavior: this nested Stack is mounted fresh (via `router.push`) whenever
// one of these is reached from `login`, seeded with only the requested
// screen as its sole route — there is no `index` beneath it in this
// navigator's own history for a default back button to target, even though
// the outer `(public)` Stack does have `login` behind it. An explicit
// handler removes the ambiguity instead of depending on that.
export default function AppTabs() {
  const router = useRouter();
  const backToLogin = () => (
    <Pressable onPress={() => router.replace('/login')} hitSlop={8}>
      <Text style={{ fontSize: 17, color: '#111111' }}>‹ Back</Text>
    </Pressable>
  );

  return (
    <Stack screenOptions={{ headerBackButtonDisplayMode: 'minimal' }}>
      <Stack.Screen name="index" options={{ headerShown: false }} />
      <Stack.Screen name="about" options={{ headerShown: true, title: 'How it works', headerLeft: backToLogin }} />
      <Stack.Screen name="signup" options={{ headerShown: true, title: 'Create your shop', headerLeft: backToLogin }} />
    </Stack>
  );
}
