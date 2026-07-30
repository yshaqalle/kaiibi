import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { Link, usePathname, useRouter } from 'expo-router';
import { ReactNode, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useAuth } from '@/hooks/use-auth';
import { signOut } from '@/lib/auth';
import type { Permission } from '@/lib/permissions';
import { updateShop, uploadShopLogo } from '@/lib/shops';

// Shared between admin-tabs.tsx (native, tablet width) and
// admin-tabs.web.tsx (web, desktop width) so the wide-layout nav only has
// one implementation to keep in sync. Narrow layouts stay
// platform-specific: native phones keep `NativeTabs`, web mobile keeps its
// own hand-rolled bottom nav.
//
// `permission` is what the route's own guard in (admin)/_layout.tsx checks —
// filtering here keeps the nav from offering a destination that would just
// bounce back.
const navItems = [
  { href: '/dashboard', label: 'Dashboard', permission: 'dashboard.view', icon: require('@/assets/images/tabIcons/home.png') },
  { href: '/pos', label: 'POS', permission: 'pos.access', icon: require('@/assets/images/tabIcons/cart.png') },
  { href: '/inventory', label: 'Inventory', permission: 'inventory.view', icon: require('@/assets/images/tabIcons/grid.png') },
  { href: '/customers', label: 'Customers', permission: 'customers.view', icon: require('@/assets/images/tabIcons/customers.png') },
  { href: '/sales', label: 'Sales', permission: 'sales.view', icon: require('@/assets/images/tabIcons/chart.png') },
] as const satisfies readonly { href: string; label: string; permission: Permission; icon: unknown }[];

type NavItem = (typeof navItems)[number];

// Extracted so each row can own its own hover state (react-native-web fires
// onHoverIn/onHoverOut on Pressable; native no-ops these harmlessly) without
// the parent re-rendering the whole nav on every mouse move.
function SidebarNavItem({ item, focused }: { item: NavItem; focused: boolean }) {
  const [hovered, setHovered] = useState(false);
  return (
    <Link href={item.href} asChild>
      <Pressable
        onHoverIn={() => setHovered(true)}
        onHoverOut={() => setHovered(false)}
        style={StyleSheet.flatten([styles.navButton, hovered && !focused && styles.navButtonHovered, focused && styles.navButtonFocused])}
      >
        <Image source={item.icon} style={[styles.navIcon, focused && styles.navIconFocused]} tintColor={focused ? '#111111' : '#777777'} />
        <Text style={[styles.navText, focused && styles.navTextFocused]}>{item.label}</Text>
      </Pressable>
    </Link>
  );
}

export function AdminSidebar({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { shop, refreshShop, can } = useAuth();
  const initial = (shop?.name ?? 'K').charAt(0).toUpperCase();
  const subtitle = shop?.categories?.[0];
  const [uploadingLogo, setUploadingLogo] = useState(false);
  const visibleNavItems = navItems.filter((item) => can(item.permission));

  // Lets the shop logo be changed straight from the sidebar avatar, not
  // just from Settings — a quick "click your logo to change it" affordance.
  // Same permission as Settings itself, since that's the screen this is a
  // shortcut for (and what the shops/storage policies check).
  const canEditShop = can('settings.access');
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

  return (
    <View style={styles.tabs}>
      <View style={styles.sidebar}>
        <View style={styles.header}>
          <Pressable onPress={editLogo} disabled={!canEditShop} style={[styles.avatar, shop?.logoUrl && styles.avatarWithLogo]}>
            {shop?.logoUrl ? <Image source={{ uri: shop.logoUrl }} contentFit="cover" style={styles.avatarImage} /> : <Text style={styles.avatarText}>{initial}</Text>}
          </Pressable>
          <View>
            <Text style={styles.shopName} numberOfLines={1}>{shop?.name ?? 'Your shop'}</Text>
            {subtitle && <Text style={styles.shopSubtitle}>{subtitle}</Text>}
          </View>
        </View>
        <View style={styles.nav}>
          {visibleNavItems.map((item) => (
            <SidebarNavItem key={item.href} item={item} focused={pathname === item.href} />
          ))}
        </View>
        <View style={styles.footer}>
          <Text style={styles.poweredBy}>Powered by Ka Iibi</Text>
          <View style={styles.footerRow}>
            {canEditShop && (
              <Pressable onPress={() => router.push('/settings')} style={styles.settingsLinkRow}>
                <Text style={styles.settingsLinkIcon}>⚙</Text>
                <Text style={styles.settingsLink}>Settings</Text>
              </Pressable>
            )}
            <Pressable onPress={() => signOut().then(() => router.replace('/login'))}>
              <Text style={styles.signOut}>Sign out</Text>
            </Pressable>
          </View>
        </View>
      </View>
      <View style={styles.slot}>{children}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  tabs: { flex: 1, flexDirection: 'row' },
  sidebar: { width: 220, flexShrink: 0, backgroundColor: '#FFFFFF', borderRightWidth: 1, borderRightColor: '#ECECEC', paddingVertical: 20 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 20, paddingBottom: 24 },
  avatar: { width: 34, height: 34, borderRadius: 9, backgroundColor: '#111111', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  // A shop's uploaded logo is usually dark ink on a transparent background
  // (meant to sit on a light surface), so the black fallback swatch above
  // would make a dark-ink logo unreadable against it. Only the no-logo
  // initial keeps the black/white treatment; once there's a real image,
  // give it a neutral light backdrop that works with either ink color.
  avatarWithLogo: { backgroundColor: '#F5F5F2' },
  avatarImage: { width: '100%', height: '100%' },
  avatarText: { color: '#FFFFFF', fontSize: 15, fontWeight: '800' },
  shopName: { color: '#111111', fontSize: 15, fontWeight: '800', maxWidth: 140 },
  shopSubtitle: { color: '#999999', fontSize: 11, marginTop: 1 },
  nav: { paddingHorizontal: 10, gap: 4 },
  navButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderRadius: 10,
    borderLeftWidth: 3,
    borderLeftColor: 'transparent',
  },
  navButtonHovered: { backgroundColor: '#F5F5F2' },
  navButtonFocused: { backgroundColor: '#F2F2F2', borderLeftColor: '#111111' },
  navIcon: { width: 19, height: 19 },
  navIconFocused: {},
  navText: { color: '#555555', fontSize: 14.5, fontWeight: '700' },
  navTextFocused: { color: '#111111', fontWeight: '800' },
  footer: { marginTop: 'auto', paddingHorizontal: 20, paddingTop: 14, borderTopWidth: 1, borderTopColor: '#ECECEC', gap: 8 },
  poweredBy: { color: '#BBBBBB', fontSize: 10, fontWeight: '700' },
  footerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  settingsLinkRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  settingsLinkIcon: { fontSize: 17, color: '#666666' },
  settingsLink: { color: '#999999', fontSize: 11, fontWeight: '700' },
  signOut: { color: '#999999', fontSize: 11, fontWeight: '700' },
  slot: { flex: 1 },
});
