import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { Link, Slot, usePathname, useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';

import { AdminSidebar } from '@/components/admin-sidebar';
import { TABLET_BREAKPOINT } from '@/constants/layout';
import { useAuth } from '@/hooks/use-auth';
import { signOut } from '@/lib/auth';
import type { Permission } from '@/lib/permissions';
import { updateShop, uploadShopLogo } from '@/lib/shops';

// Bottom nav for narrow/mobile-web only — the wide layout uses the shared
// `AdminSidebar` (see admin-sidebar.tsx), which has its own icon set.
// `permission` mirrors the route guard in (admin)/_layout.tsx, so a role that
// can't open a screen never sees a tab for it.
const navItems = [
  { href: '/dashboard', label: 'Dashboard', permission: 'dashboard.view', icon: '🏠' },
  { href: '/pos', label: 'POS', permission: 'pos.access', icon: '🛒' },
  { href: '/inventory', label: 'Inventory', permission: 'inventory.view', icon: '▦' },
  { href: '/customers', label: 'Customers', permission: 'customers.view', icon: '👥' },
  { href: '/sales', label: 'Sales', permission: 'sales.view', icon: '📈' },
] as const satisfies readonly { href: string; label: string; permission: Permission; icon: string }[];

// Below `compactBreakpoint` the persistent sidebar would eat more than half
// a phone screen (and leave two-pane screens like POS with almost nothing
// to work with), so it collapses into a slim top header + bottom tab bar
// instead — the standard mobile-web nav shape.
export default function AdminTabs() {
  const router = useRouter();
  const pathname = usePathname();
  const { shop, refreshShop, can } = useAuth();
  const { width } = useWindowDimensions();
  const compact = width < TABLET_BREAKPOINT;
  const initial = (shop?.name ?? 'K').charAt(0).toUpperCase();
  const [uploadingLogo, setUploadingLogo] = useState(false);
  const canEditShop = can('settings.access');
  const visibleNavItems = navItems.filter((item) => can(item.permission));

  // Lets the shop logo be changed straight from the mobile header avatar,
  // not just from Settings — a quick "click your logo to change it"
  // affordance. The wide-layout equivalent lives in AdminSidebar. Gated on
  // the same permission as Settings, the screen it shortcuts.
  const editLogo = async () => {
    if (!shop || uploadingLogo || !canEditShop) return;
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) return;
    const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsEditing: true, aspect: [1, 1], quality: 0.8 });
    if (result.canceled) return;
    setUploadingLogo(true);
    try {
      const logoUrl = await uploadShopLogo(shop.id, result.assets[0].uri);
      await updateShop(shop.id, { logoUrl });
      await refreshShop();
    } finally {
      setUploadingLogo(false);
    }
  };

  if (compact) {
    return (
      <View style={styles.mobileRoot}>
        <View style={styles.mobileHeader}>
          <View style={styles.mobileHeaderLeft}>
            <Pressable onPress={editLogo} disabled={!canEditShop} style={[styles.avatarSmall, shop?.logoUrl && styles.avatarWithLogo]}>
              {shop?.logoUrl ? <Image source={{ uri: shop.logoUrl }} contentFit="cover" style={styles.avatarImage} /> : <Text style={styles.avatarText}>{initial}</Text>}
            </Pressable>
            <Text style={styles.shopNameCompact} numberOfLines={1}>{shop?.name ?? 'Your shop'}</Text>
          </View>
          <View style={styles.mobileHeaderRight}>
            {canEditShop && (
              <Pressable onPress={() => router.push('/settings')} style={styles.settingsButtonCompact} hitSlop={8}>
                <Text style={styles.settingsIcon}>⚙</Text>
              </Pressable>
            )}
            <Pressable onPress={() => signOut().then(() => router.replace('/signup'))}>
              <Text style={styles.signOutCompact}>Sign out</Text>
            </Pressable>
          </View>
        </View>
        <View style={styles.mobileSlot}><Slot /></View>
        <View style={styles.bottomNav}>
          {visibleNavItems.map((item) => {
            const isFocused = pathname === item.href;
            return (
              <Link key={item.href} href={item.href} asChild>
                <Pressable style={styles.bottomNavItem}>
                  <View style={[styles.bottomNavIconWrap, isFocused && styles.bottomNavIconWrapFocused]}>
                    <Text style={[styles.bottomNavIcon, isFocused && styles.bottomNavIconFocused]}>{item.icon}</Text>
                  </View>
                  <Text style={[styles.bottomNavText, isFocused && styles.bottomNavTextFocused]} numberOfLines={1}>{item.label}</Text>
                </Pressable>
              </Link>
            );
          })}
        </View>
      </View>
    );
  }

  return (
    <AdminSidebar>
      <Slot />
    </AdminSidebar>
  );
}

const styles = StyleSheet.create({
  avatarImage: { width: '100%', height: '100%' },
  avatarText: { color: '#FFFFFF', fontSize: 15, fontWeight: '800' },

  mobileRoot: { flex: 1 },
  mobileHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', height: 52, paddingHorizontal: 16, borderBottomWidth: 1, borderBottomColor: '#ECECEC', backgroundColor: '#FFFFFF' },
  mobileHeaderLeft: { flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1, marginRight: 12 },
  avatarSmall: { width: 26, height: 26, borderRadius: 7, backgroundColor: '#111111', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  // See AdminSidebar's avatarWithLogo -- same reasoning: a logo's own dark
  // ink needs a light backdrop, not the black no-logo fallback.
  avatarWithLogo: { backgroundColor: '#F5F5F2' },
  shopNameCompact: { color: '#111111', fontSize: 14, fontWeight: '800', flexShrink: 1 },
  mobileHeaderRight: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  settingsButtonCompact: { padding: 2 },
  settingsIcon: { fontSize: 24, color: '#555555' },
  signOutCompact: { color: '#999999', fontSize: 12, fontWeight: '700' },
  mobileSlot: { flex: 1 },
  bottomNav: { flexDirection: 'row', borderTopWidth: 1, borderTopColor: '#ECECEC', backgroundColor: '#FFFFFF', paddingBottom: 12, paddingTop: 10 },
  bottomNavItem: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 4, paddingVertical: 4 },
  bottomNavIconWrap: { width: 46, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center' },
  bottomNavIconWrapFocused: { backgroundColor: '#111111' },
  bottomNavIcon: { fontSize: 18, color: '#999999' },
  bottomNavIconFocused: { color: '#FFFFFF' },
  bottomNavText: { color: '#999999', fontSize: 11.5, fontWeight: '700' },
  bottomNavTextFocused: { color: '#111111', fontWeight: '800' },
});
