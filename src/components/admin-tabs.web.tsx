import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { Link, Slot, usePathname, useRouter } from 'expo-router';
import { useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';

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
type NavVisibility = { can: (p: Permission) => boolean; canAny: (p: Permission[]) => boolean; hasActiveMembership: boolean };

const navItems = [
  { href: '/dashboard', label: 'Dashboard', icon: '🏠', isVisible: (ctx: NavVisibility) => ctx.can('dashboard.view') },
  { href: '/pos', label: 'POS', icon: '🛒', isVisible: (ctx: NavVisibility) => ctx.can('pos.access') },
  { href: '/inventory', label: 'Inventory', icon: '▦', isVisible: (ctx: NavVisibility) => ctx.can('inventory.view') },
  {
    href: '/people',
    label: 'People',
    icon: '👥',
    isVisible: (ctx: NavVisibility) => ctx.hasActiveMembership || ctx.canAny(['customers.view', 'staff.manage', 'people.timeoff.approve', 'people.payroll.manage', 'people.timesheet.view']),
  },
  { href: '/accounting', label: 'Accounting', icon: '📈', isVisible: (ctx: NavVisibility) => ctx.can('sales.view') },
] as const satisfies readonly { href: string; label: string; icon: string; isVisible: (ctx: NavVisibility) => boolean }[];

// Below `compactBreakpoint` the persistent sidebar would eat more than half
// a phone screen (and leave two-pane screens like POS with almost nothing
// to work with), so it collapses into a slim top header + bottom tab bar
// instead — the standard mobile-web nav shape.
export default function AdminTabs() {
  const router = useRouter();
  const pathname = usePathname();
  const { shop, refreshShop, can, canAny, myMembership } = useAuth();
  const { width } = useWindowDimensions();
  const compact = width < TABLET_BREAKPOINT;
  const initial = (shop?.name ?? 'K').charAt(0).toUpperCase();
  const [uploadingLogo, setUploadingLogo] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const canEditShop = can('settings.access');
  const visibleNavItems = navItems.filter((item) => item.isVisible({ can, canAny, hasActiveMembership: Boolean(myMembership?.active) }));

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
            <Pressable onPress={() => setMenuOpen(true)} style={styles.menuButtonCompact} hitSlop={8}>
              <Text style={styles.menuIconCompact}>☰</Text>
            </Pressable>
          </View>
        </View>
        <Modal visible={menuOpen} transparent animationType="fade" onRequestClose={() => setMenuOpen(false)}>
          <Pressable style={styles.menuBackdrop} onPress={() => setMenuOpen(false)}>
            <View style={styles.menuSheet}>
              {canEditShop && (
                <>
                  <Pressable
                    onPress={() => {
                      setMenuOpen(false);
                      router.push('/settings');
                    }}
                    style={({ pressed }) => [styles.menuItem, { opacity: pressed ? 0.6 : 1 }]}
                  >
                    <Text style={styles.menuItemIcon}>⚙</Text>
                    <Text style={styles.menuItemText}>Settings</Text>
                  </Pressable>
                  <View style={styles.menuDivider} />
                </>
              )}
              <Pressable
                onPress={() => {
                  setMenuOpen(false);
                  signOut().then(() => router.replace('/signup'));
                }}
                style={({ pressed }) => [styles.menuItem, { opacity: pressed ? 0.6 : 1 }]}
              >
                <Text style={styles.menuItemText}>Sign out</Text>
              </Pressable>
            </View>
          </Pressable>
        </Modal>
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
  menuButtonCompact: { paddingVertical: 7, paddingHorizontal: 10, borderRadius: 8, backgroundColor: '#F5F5F2' },
  menuIconCompact: { fontSize: 16, color: '#111111' },
  menuBackdrop: { flex: 1 },
  menuSheet: { position: 'absolute', top: 56, right: 16, minWidth: 160, borderRadius: 12, borderWidth: 1, borderColor: '#ECECEC', paddingVertical: 6, overflow: 'hidden', backgroundColor: '#FFFFFF' },
  menuItem: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 12, paddingHorizontal: 14 },
  menuItemIcon: { fontSize: 15, color: '#111111' },
  menuItemText: { fontSize: 14, fontWeight: '700', color: '#111111' },
  menuDivider: { height: StyleSheet.hairlineWidth, backgroundColor: '#ECECEC' },
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
