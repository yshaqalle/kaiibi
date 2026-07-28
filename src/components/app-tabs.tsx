import { Stack } from 'expo-router';

// Native only — web's version of this component (`app-tabs.web.tsx`) keeps
// its own top-nav `Tabs`/`TabSlot` implementation, untouched. On native,
// `login` (see `(public)/_layout.tsx`) is the app's home screen; `about`
// and `signup` are pushed screens reached via buttons/links from login or
// from each other. `index` is never actually shown to a user — it's Task
// 3's redirect-to-`/login` stub, kept headerless so no header flashes
// before the redirect fires.
export default function AppTabs() {
  return (
    <Stack screenOptions={{ headerBackButtonDisplayMode: 'minimal' }}>
      <Stack.Screen name="index" options={{ headerShown: false }} />
      <Stack.Screen name="about" options={{ headerShown: true, title: 'How it works' }} />
      <Stack.Screen name="signup" options={{ headerShown: true, title: 'Create your shop' }} />
    </Stack>
  );
}
