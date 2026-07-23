import { Stack } from 'expo-router';

// `(tabs)` hosts the 3 tab-bar routes (index/about/signup) via AppTabs.
// `login` is not a tab — it's a screen that should push on top of the tab
// bar, the same way it does automatically on native. This Stack is what
// makes that push-over-tabs behavior work on web too: expo-router/ui's
// `Tabs`/`TabSlot` only ever renders routes declared as `<TabTrigger>`, so a
// route outside that set needs a real Stack screen to host it.
export default function PublicLayout() {
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="(tabs)" />
      <Stack.Screen name="login" options={{ headerShown: true, title: 'Log in' }} />
    </Stack>
  );
}
