import { Redirect, Stack } from 'expo-router';
import { ActivityIndicator, View } from 'react-native';

import { useAuth } from '@/hooks/use-auth';

export default function OwnerLayout() {
  const { loading, session, profile } = useAuth();

  if (loading) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator />
      </View>
    );
  }

  if (!session || profile?.role !== 'owner') {
    return <Redirect href="/signup" />;
  }

  // `(tabs)` hosts the 4 tab-bar routes (dashboard/sell/inventory/sales) via
  // OwnerTabs. `product/new` and `product/[id]` are not tabs — they're detail
  // screens that should push on top of the tab bar, the same way they do
  // automatically on native. This Stack is what makes that push-over-tabs
  // behavior work on web too: expo-router/ui's `Tabs`/`TabSlot` only ever
  // renders routes declared as `<TabTrigger>`, so a route outside that set
  // needs a real Stack screen to host it.
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="(tabs)" />
      <Stack.Screen name="product/new" options={{ headerShown: true, title: 'Add product' }} />
      <Stack.Screen name="product/[id]" options={{ headerShown: true, title: 'Edit product' }} />
    </Stack>
  );
}
