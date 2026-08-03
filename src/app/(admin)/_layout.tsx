import { Redirect, Stack, usePathname, useRouter } from 'expo-router';
import { ActivityIndicator, Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { useAuth } from '@/hooks/use-auth';
import { signOut } from '@/lib/auth';
import { firstAllowedRoute, permissionForPath } from '@/lib/permissions';

export default function AdminLayout() {
  const { loading, session, profile, permissions, can, myMembership } = useAuth();
  const pathname = usePathname();

  if (loading) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator />
      </View>
    );
  }

  if (!session || (profile?.role !== 'admin' && profile?.role !== 'staff')) {
    // This file isn't platform-split, so it serves both web and native.
    // Web's post-logout/unauthenticated landing spot is still `/signup`
    // (unchanged). Native's `/signup` is no longer a reasonable landing
    // spot — it's now a bare pushed wizard, not a tab — so native goes to
    // `/login` instead, matching this app's native-only login-first home.
    return <Redirect href={Platform.OS === 'web' ? '/signup' : '/login'} />;
  }

  // The single choke point for per-permission route access. Every `(admin)`
  // route renders through this layout, so gating here covers deep links, a
  // typed URL on web, and the default landing tab in one place — the nav
  // filtering in AdminTabs/AdminSidebar is only there so the UI doesn't offer
  // a route this would immediately bounce.
  //
  // This is the client half of the gate; the DB half (migration 0024's RLS)
  // is what actually protects the data, since nothing stops a staff member
  // querying the API directly.
  const landing = firstAllowedRoute(permissions);
  // People → Team includes self-service for any active staff member, even if
  // their role grants no operational or management permissions.
  const canReachMe = profile.role === 'admin' || Boolean(myMembership?.active);
  const fallback = landing ?? (canReachMe ? '/people' : null);

  const isMeRoute = pathname === '/me' || pathname.startsWith('/me/');
  const isPeopleRoute = pathname === '/people' || pathname.startsWith('/people/');
  const required = permissionForPath(pathname);
  const allowed = isMeRoute ? canReachMe : (isPeopleRoute && canReachMe) || !required || required.some(can);
  if (!allowed) {
    return fallback ? <Redirect href={fallback} /> : <NoAccessScreen />;
  }
  if (!isMeRoute && !landing && !required) {
    return fallback ? <Redirect href={fallback} /> : <NoAccessScreen />;
  }

  // `(tabs)` hosts the 5 tab-bar routes (dashboard/pos/inventory/customers/sales)
  // via AdminTabs. `product/new`, `product/[id]` and `settings` are not tabs —
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

// A staff account whose role grants nothing (or whose role was emptied while
// they were signed in) has no route to land on — show why instead of an
// endless redirect or a blank shell.
function NoAccessScreen() {
  const router = useRouter();
  return (
    <View style={styles.noAccess}>
      <Text style={styles.noAccessTitle}>No access yet</Text>
      <Text style={styles.noAccessBody}>
        Your account isn&apos;t allowed to open any part of this shop. Ask the shop owner to give your role
        some permissions.
      </Text>
      <Pressable onPress={() => signOut().then(() => router.replace(Platform.OS === 'web' ? '/signup' : '/login'))}>
        <Text style={styles.noAccessSignOut}>Sign out</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  noAccess: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 10, backgroundColor: '#FFFFFF' },
  noAccessTitle: { color: '#111111', fontSize: 18, fontWeight: '800' },
  noAccessBody: { color: '#777777', fontSize: 13, textAlign: 'center', maxWidth: 320, lineHeight: 19 },
  noAccessSignOut: { color: '#111111', fontSize: 12, fontWeight: '800', marginTop: 8 },
});
