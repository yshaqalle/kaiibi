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

  // `(tabs)` hosts the 4 tab-bar routes (dashboard/pos/inventory/sales) via
  // OwnerTabs. `product/new`, `product/[id]` and `settings` are not tabs —
  // they're detail screens that should push on top of the tab bar, the same
  // way they do automatically on native. This Stack is what makes that
  // push-over-tabs behavior work on web too: expo-router/ui's
  // `Tabs`/`TabSlot` only ever renders routes declared as `<TabTrigger>`, so
  // a route outside that set needs a real Stack screen to host it.
  //
  // `headerShown` stays false for all of them (not just `(tabs)`): React
  // Navigation's native Stack header renders a title but no usable back
  // control on web, so each of these screens brings its own `ScreenHeader`
  // with an explicit Back + Home instead of relying on this Stack's header.
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="(tabs)" />
      <Stack.Screen name="product/new" />
      <Stack.Screen name="product/[id]" />
      <Stack.Screen name="settings" />
    </Stack>
  );
}
