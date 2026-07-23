import { Link, Slot, usePathname, useRouter } from 'expo-router';
import { Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';

import { useAuth } from '@/hooks/use-auth';
import { signOut } from '@/lib/auth';

// This intentionally avoids expo-router/ui's `Tabs`/`TabList`/`TabTrigger`:
// on web that combo lays out each `TabTrigger` as if positioning items in a
// horizontal bar (it's built around an animated indicator that needs
// per-item x-offsets), so wrapping them in a plain vertical `View` produced
// a nav column whose items rendered past the sidebar's right edge, hidden
// under the main content. A plain `Link` + `usePathname` sidesteps that
// layout math entirely and gives full control over the vertical stack.
const navItems = [
  { href: '/dashboard', label: 'Dashboard', icon: '🏠' },
  { href: '/pos', label: 'POS', icon: '🛒' },
  { href: '/inventory', label: 'Inventory', icon: '▦' },
  { href: '/sales', label: 'Sales', icon: '📈' },
] as const;

// Below this width the persistent 220px sidebar would eat more than half a
// phone screen (and leave two-pane screens like POS with almost nothing to
// work with), so it collapses into a slim top header + bottom tab bar
// instead — the standard mobile-web nav shape.
const compactBreakpoint = 820;

export default function OwnerTabs() {
  const router = useRouter();
  const pathname = usePathname();
  const { shop } = useAuth();
  const { width } = useWindowDimensions();
  const compact = width < compactBreakpoint;
  const initial = (shop?.name ?? 'K').charAt(0).toUpperCase();
  const subtitle = shop?.categories?.[0];

  if (compact) {
    return (
      <View style={styles.mobileRoot}>
        <View style={styles.mobileHeader}>
          <View style={styles.mobileHeaderLeft}>
            <View style={styles.avatarSmall}><Text style={styles.avatarText}>{initial}</Text></View>
            <Text style={styles.shopNameCompact} numberOfLines={1}>{shop?.name ?? 'Your shop'}</Text>
          </View>
          <View style={styles.mobileHeaderRight}>
            <Pressable onPress={() => router.push('/settings')} style={styles.settingsButtonCompact}>
              <Text style={styles.settingsIcon}>⚙</Text>
            </Pressable>
            <Pressable onPress={() => signOut().then(() => router.replace('/signup'))}>
              <Text style={styles.signOutCompact}>Sign out</Text>
            </Pressable>
          </View>
        </View>
        <View style={styles.mobileSlot}><Slot /></View>
        <View style={styles.bottomNav}>
          {navItems.map((item) => {
            const isFocused = pathname === item.href;
            return (
              <Link key={item.href} href={item.href} asChild>
                <Pressable style={styles.bottomNavItem}>
                  <View style={[styles.bottomNavIconWrap, isFocused && styles.bottomNavIconWrapFocused]}>
                    <Text style={[styles.bottomNavIcon, isFocused && styles.bottomNavIconFocused]}>{item.icon}</Text>
                  </View>
                  <Text style={[styles.bottomNavText, isFocused && styles.bottomNavTextFocused]}>{item.label}</Text>
                </Pressable>
              </Link>
            );
          })}
        </View>
      </View>
    );
  }

  return (
    <View style={styles.tabs}>
      <View style={styles.sidebar}>
        <View style={styles.header}>
          <View style={styles.avatar}><Text style={styles.avatarText}>{initial}</Text></View>
          <View>
            <Text style={styles.shopName} numberOfLines={1}>{shop?.name ?? 'Your shop'}</Text>
            {subtitle && <Text style={styles.shopSubtitle}>{subtitle}</Text>}
          </View>
        </View>
        <View style={styles.nav}>
          {navItems.map((item) => {
            const isFocused = pathname === item.href;
            return (
              <Link key={item.href} href={item.href} asChild>
                <Pressable style={StyleSheet.flatten([styles.navButton, isFocused && styles.navButtonFocused])}>
                  <Text style={styles.navIcon}>{item.icon}</Text>
                  <Text style={[styles.navText, isFocused && styles.navTextFocused]}>{item.label}</Text>
                </Pressable>
              </Link>
            );
          })}
        </View>
        <View style={styles.footer}>
          <Text style={styles.poweredBy}>Powered by Ka Iibi</Text>
          <View style={styles.footerRow}>
            <Pressable onPress={() => router.push('/settings')}>
              <Text style={styles.settingsLink}>⚙ Settings</Text>
            </Pressable>
            <Pressable onPress={() => signOut().then(() => router.replace('/signup'))}>
              <Text style={styles.signOut}>Sign out</Text>
            </Pressable>
          </View>
        </View>
      </View>
      <View style={styles.slot}><Slot /></View>
    </View>
  );
}

const styles = StyleSheet.create({
  tabs: { flex: 1, flexDirection: 'row' },
  sidebar: { width: 220, flexShrink: 0, backgroundColor: '#FFFFFF', borderRightWidth: 1, borderRightColor: '#ECECEC', paddingVertical: 20 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 20, paddingBottom: 24 },
  avatar: { width: 34, height: 34, borderRadius: 9, backgroundColor: '#111111', alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: '#FFFFFF', fontSize: 15, fontWeight: '800' },
  shopName: { color: '#111111', fontSize: 15, fontWeight: '800', maxWidth: 140 },
  shopSubtitle: { color: '#999999', fontSize: 11, marginTop: 1 },
  nav: { paddingHorizontal: 10, gap: 6 },
  navButton: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12, paddingVertical: 10, borderRadius: 8 },
  navButtonFocused: { backgroundColor: '#F2F2F2' },
  navIcon: { fontSize: 15, width: 18, textAlign: 'center' },
  navText: { color: '#555555', fontSize: 13, fontWeight: '600' },
  navTextFocused: { color: '#111111', fontWeight: '800' },
  footer: { marginTop: 'auto', paddingHorizontal: 20, paddingTop: 14, borderTopWidth: 1, borderTopColor: '#ECECEC', gap: 8 },
  poweredBy: { color: '#BBBBBB', fontSize: 10, fontWeight: '700' },
  footerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  settingsLink: { color: '#999999', fontSize: 11, fontWeight: '700' },
  signOut: { color: '#999999', fontSize: 11, fontWeight: '700' },
  slot: { flex: 1 },

  mobileRoot: { flex: 1 },
  mobileHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', height: 52, paddingHorizontal: 16, borderBottomWidth: 1, borderBottomColor: '#ECECEC', backgroundColor: '#FFFFFF' },
  mobileHeaderLeft: { flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1, marginRight: 12 },
  avatarSmall: { width: 26, height: 26, borderRadius: 7, backgroundColor: '#111111', alignItems: 'center', justifyContent: 'center' },
  shopNameCompact: { color: '#111111', fontSize: 14, fontWeight: '800', flexShrink: 1 },
  mobileHeaderRight: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  settingsButtonCompact: { padding: 2 },
  settingsIcon: { fontSize: 16, color: '#666666' },
  signOutCompact: { color: '#999999', fontSize: 12, fontWeight: '700' },
  mobileSlot: { flex: 1 },
  bottomNav: { flexDirection: 'row', borderTopWidth: 1, borderTopColor: '#ECECEC', backgroundColor: '#FFFFFF', paddingBottom: 10, paddingTop: 8 },
  bottomNavItem: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 3, paddingVertical: 4 },
  bottomNavIconWrap: { width: 40, height: 26, borderRadius: 13, alignItems: 'center', justifyContent: 'center' },
  bottomNavIconWrapFocused: { backgroundColor: '#111111' },
  bottomNavIcon: { fontSize: 15, color: '#999999' },
  bottomNavIconFocused: { color: '#FFFFFF' },
  bottomNavText: { color: '#999999', fontSize: 11, fontWeight: '700' },
  bottomNavTextFocused: { color: '#111111', fontWeight: '800' },
});
