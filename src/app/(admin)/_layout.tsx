import { Redirect, Stack, usePathname, useRouter } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { SupportSheet } from '@/components/support/support-sheet';
import { Colors } from '@/constants/theme';
import { useAuth } from '@/hooks/use-auth';
import { signOut } from '@/lib/auth';
import { moduleForPath, MODULES, type Module } from '@/lib/entitlements';
import { firstAllowedRoute, permissionForPath } from '@/lib/permissions';

export default function AdminLayout() {
  const { loading, session, profile, permissions, can, myMembership, hasModule, entitlements } = useAuth();
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

  // The entitlement half of the same choke point. Checked AFTER permissions so
  // the more specific answer wins: someone whose role doesn't grant a screen
  // should be told that, not sold an upgrade for something they still couldn't
  // open.
  //
  // Renders in place rather than redirecting. A redirect would loop whenever
  // the un-entitled route IS the landing tab -- and an upgrade wall is the
  // whole point, since a screen the shop can't reach is exactly where telling
  // them what it costs belongs.
  const requiredModule = moduleForPath(pathname);
  if (requiredModule && !hasModule(requiredModule)) {
    return <UpgradeScreen module={requiredModule} resolved={entitlements.resolved} />;
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
  const [supportOpen, setSupportOpen] = useState(false);
  return (
    <View style={styles.noAccess}>
      <Text style={styles.noAccessTitle}>No access yet</Text>
      <Text style={styles.noAccessBody}>
        Your account isn&apos;t allowed to open any part of this shop. Ask the shop owner to give your role
        some permissions.
      </Text>
      {/* This screen is the one place a person can be completely stuck: their role
          grants nothing, so there is no shell, no ☰, and no other route out. */}
      <Pressable onPress={() => setSupportOpen(true)}>
        <Text style={styles.noAccessSupport}>Contact support</Text>
      </Pressable>
      <SupportSheet visible={supportOpen} onClose={() => setSupportOpen(false)} />
      <Pressable onPress={() => signOut().then(() => router.replace(Platform.OS === 'web' ? '/signup' : '/login'))}>
        <Text style={styles.noAccessSignOut}>Sign out</Text>
      </Pressable>
    </View>
  );
}

// A screen the shop's plan doesn't cover. Distinct from NoAccessScreen: that
// one is about who you are and can only be fixed by the shop owner, this one is
// about what the shop pays for and is fixed by upgrading.
//
// Says plainly that nothing has been lost. A shop that opens Accounting after a
// lapse and sees only a paywall will assume its books are gone -- the most
// damaging thing this screen could imply, and the least true.
function UpgradeScreen({ module, resolved }: { module: Module; resolved: boolean }) {
  const router = useRouter();
  const meta = MODULES.find((m) => m.key === module);
  const [supportOpen, setSupportOpen] = useState(false);

  // The lookup failed, so we genuinely don't know what this shop is entitled
  // to. Access stays closed -- the server would refuse the writes anyway -- but
  // telling a possibly-paid-up customer that this "isn't on your plan" would be
  // a false accusation dressed up as an upsell.
  if (!resolved) {
    return (
      <View style={styles.noAccess}>
        <Text style={styles.noAccessTitle}>Just a moment</Text>
        <Text style={styles.noAccessBody}>
          We couldn&apos;t check your plan just now, so this screen is on hold. This is a problem on our side, not
          with your account.
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.noAccess}>
      <Text style={styles.upgradeLock}>🔒</Text>
      <Text style={styles.noAccessTitle}>{meta?.label ?? 'This feature'} isn&apos;t on your plan</Text>
      <Text style={styles.noAccessBody}>{meta?.description}</Text>
      <Text style={styles.upgradeReassure}>
        Anything you already added is safe and still here — it just can&apos;t be changed until your plan covers
        this again.
      </Text>
      {/* This screen is the one place a shop can be completely stuck: the module
          is walled off, so there is no shell, no ☰, and no other route out. */}
      <Pressable onPress={() => setSupportOpen(true)}>
        <Text style={styles.noAccessSupport}>Contact support</Text>
      </Pressable>
      <SupportSheet visible={supportOpen} onClose={() => setSupportOpen(false)} />
      <Pressable onPress={() => router.push('/settings')} style={styles.upgradeButton}>
        <Text style={styles.upgradeButtonText}>See plans</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  noAccess: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 10, backgroundColor: '#FFFFFF' },
  noAccessTitle: { color: '#111111', fontSize: 18, fontWeight: '800', textAlign: 'center' },
  noAccessBody: { color: '#777777', fontSize: 13, textAlign: 'center', maxWidth: 320, lineHeight: 19 },
  noAccessSignOut: { color: '#111111', fontSize: 12, fontWeight: '800', marginTop: 8 },
  noAccessSupport: { fontSize: 13.5, fontWeight: '800', color: Colors.light.bentoAccentInk, marginBottom: 14 },
  upgradeLock: { fontSize: 30, marginBottom: 2 },
  upgradeReassure: { color: '#9A6412', fontSize: 12, textAlign: 'center', maxWidth: 320, lineHeight: 18, marginTop: 2 },
  upgradeButton: { backgroundColor: '#111111', borderRadius: 10, paddingHorizontal: 18, paddingVertical: 11, marginTop: 10 },
  upgradeButtonText: { color: '#FFFFFF', fontSize: 12, fontWeight: '800' },
});
